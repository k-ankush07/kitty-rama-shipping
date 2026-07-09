import { authenticate } from "../shopify.server";
import { getContractPreview } from "../lib/billing-preview.server";

const EXTRA_SETTINGS_NAMESPACE = "subscription_app";

function metaKeyForGroup(groupId) {
  const numericId = groupId.split("/").pop();
  return `extra_settings_${numericId}`;
}

// Same threshold logic as process-billing-cycles.jsx — kept in sync so a
// cycle qualifies for an action the same way whether it's applied here (at
// contract creation) or later by the cron (as a fallback).
function collectActionsForCycle(settings, cycleIndex) {
  const actions = [];
  if (!settings) return actions;

  if (settings.shippingDiscount?.enabled && cycleIndex >= settings.shippingDiscount.after) {
    actions.push({ ...settings.shippingDiscount, type: "SHIPPING_DISCOUNT" });
  }
  if (settings.quantityChange?.enabled && cycleIndex >= settings.quantityChange.after) {
    actions.push({ ...settings.quantityChange, type: "QUANTITY_CHANGE" });
  }
  for (const auto of settings.automaticActions || []) {
    if (cycleIndex >= auto.afterCycle) {
      actions.push({ ...auto, type: auto.type });
    }
  }
  return actions;
}

// Opens a billing-cycle-scoped draft, applies each action, then commits.
// This is the exact same logic as applyActionsToCycle in
// process-billing-cycles.jsx — duplicated here (rather than imported) since
// this file runs from a webhook context, not the cron route. Keep both
// copies in sync if you change one.
async function applyActionsToCycle(admin, contractId, cycleIndex, actions) {
  const editRes = await admin.graphql(`
    mutation openCycleDraft($contractId: ID!, $index: Int!) {
      subscriptionBillingCycleContractEdit(
        billingCycleInput: { contractId: $contractId, selector: { index: $index } }
      ) {
        draft {
          id
          lines(first: 10) {
            edges { node { id } }
          }
        }
        userErrors { field message }
      }
    }
  `, { variables: { contractId, index: cycleIndex } });

  const editData = await editRes.json();
  const payload = editData.data?.subscriptionBillingCycleContractEdit;
  if (payload?.userErrors?.length) {
    throw new Error(`subscriptionBillingCycleContractEdit failed: ${payload.userErrors[0].message}`);
  }
  if (!payload?.draft) {
    throw new Error("subscriptionBillingCycleContractEdit returned no draft");
  }

  const draftId = payload.draft.id;
  const lineId = payload.draft.lines.edges[0]?.node?.id;

  for (const action of actions) {
    if (action.type === "QUANTITY_CHANGE") {
      if (!lineId) throw new Error("QUANTITY_CHANGE failed: no line found on draft to update");
      const res = await admin.graphql(`
        mutation updateLineQty($draftId: ID!, $lineId: ID!, $qty: Int!) {
          subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: { quantity: $qty }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId, qty: action.value } });
      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineUpdate?.userErrors;
      if (errors?.length) throw new Error(`QUANTITY_CHANGE failed: ${errors[0].message}`);
    }

    if (action.type === "PRODUCT_SWAP" || action.type === "VARIANT_SWAP") {
      if (!lineId) throw new Error(`${action.type} failed: no line found on draft to update`);
      if (!action.variantId) throw new Error(`${action.type} failed: no variantId configured for this action`);
      const res = await admin.graphql(`
        mutation swapLine($draftId: ID!, $lineId: ID!, $variantId: ID!) {
          subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: { productVariantId: $variantId }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId, variantId: action.variantId } });
      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineUpdate?.userErrors;
      if (errors?.length) throw new Error(`${action.type} failed: ${errors[0].message}`);
    }

    if (action.type === "SHIPPING_DISCOUNT") {
      const res = await admin.graphql(`
        mutation addShippingDiscount($draftId: ID!) {
          subscriptionDraftFreeShippingDiscountAdd(
            draftId: $draftId
            input: { title: "Auto shipping discount" }
          ) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId } });
      const data = await res.json();
      const errors = data.data?.subscriptionDraftFreeShippingDiscountAdd?.userErrors;

      if (errors?.length) {
        const alreadyHasFreeShipping = errors.some((e) =>
          /only one free shipping discount/i.test(e.message)
        );
        if (!alreadyHasFreeShipping) {
          throw new Error(`SHIPPING_DISCOUNT failed: ${errors[0].message}`);
        }
        // The draft/contract already carries a free shipping discount — most
        // likely because this cycle was already processed by an earlier
        // (possibly redelivered) webhook call, or the selling plan itself
        // grants free shipping at creation time. Treat as already-satisfied
        // rather than aborting the remaining actions in this loop.
        console.log(
          `[applyActionsToCycle] SHIPPING_DISCOUNT skipped for ${contractId} cycle ${cycleIndex} — draft already has a free shipping discount.`
        );
      }
    }

    if (action.type === "REMOVE_PRODUCT" || action.type === "REMOVE_VARIANT") {
      if (!lineId) throw new Error(`${action.type} failed: no line found on draft to remove`);
      const res = await admin.graphql(`
        mutation removeLine($draftId: ID!, $lineId: ID!) {
          subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId } });
      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineRemove?.userErrors;
      if (errors?.length) throw new Error(`${action.type} failed: ${errors[0].message}`);
    }

    if (action.type === "ADD_PRODUCT") {
      if (!action.variantId) throw new Error("ADD_PRODUCT failed: no variantId configured for this action");
      const res = await admin.graphql(`
        mutation addLine($draftId: ID!, $variantId: ID!, $qty: Int!) {
          subscriptionDraftLineAdd(draftId: $draftId, input: { productVariantId: $variantId, quantity: $qty }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, variantId: action.variantId, qty: 1 } });
      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineAdd?.userErrors;
      if (errors?.length) throw new Error(`ADD_PRODUCT failed: ${errors[0].message}`);
    }
  }

  const commitRes = await admin.graphql(`
    mutation commitCycleDraft($draftId: ID!) {
      subscriptionBillingCycleContractDraftCommit(draftId: $draftId) {
        userErrors { field message }
      }
    }
  `, { variables: { draftId } });
  const commitData = await commitRes.json();
  const commitErrors = commitData.data?.subscriptionBillingCycleContractDraftCommit?.userErrors;
  if (commitErrors?.length) {
    throw new Error(`subscriptionBillingCycleContractDraftCommit failed: ${commitErrors[0].message}`);
  }
}

// Marker set shared with process-billing-cycles.jsx, stored on the Shop
// metafield, so the cron knows this cycle's draft was already edited here
// and doesn't redundantly (or conflictingly) re-edit it. Also used by this
// webhook itself to skip redundant work on redelivered webhook events.
const PROCESSED_CYCLES_KEY = "processed_billing_cycles";
const AUDIT_LOG_KEY = "audit_log";

async function getShopId(admin) {
  const res = await admin.graphql(`{ shop { id } }`);
  const data = await res.json();
  return data.data?.shop?.id;
}

async function getProcessedCycles(admin) {
  const res = await admin.graphql(`
    query {
      shop {
        metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${PROCESSED_CYCLES_KEY}") {
          value
        }
      }
    }
  `);
  const data = await res.json();
  try {
    return new Set(JSON.parse(data.data?.shop?.metafield?.value || "[]"));
  } catch {
    return new Set();
  }
}

async function isCycleProcessed(admin, marker) {
  const set = await getProcessedCycles(admin);
  return set.has(marker);
}

async function markCycleProcessed(admin, shopId, marker) {
  // Re-read right before writing to minimize (though not fully eliminate,
  // since Shopify metafields aren't compare-and-swap) the chance of two
  // concurrent webhook deliveries clobbering each other's marker writes.
  const set = await getProcessedCycles(admin);
  set.add(marker);
  const trimmed = Array.from(set).slice(-500);

  await admin.graphql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, {
    variables: {
      metafields: [{
        ownerId: shopId,
        namespace: EXTRA_SETTINGS_NAMESPACE,
        key: PROCESSED_CYCLES_KEY,
        type: "json",
        value: JSON.stringify(trimmed),
      }],
    },
  });
}

async function appendAuditLog(admin, shopId, entry) {
  const res = await admin.graphql(`
    query {
      shop {
        metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${AUDIT_LOG_KEY}") {
          value
        }
      }
    }
  `);
  const data = await res.json();
  let log = [];
  try {
    log = JSON.parse(data.data?.shop?.metafield?.value || "[]");
  } catch {
    log = [];
  }
  log.push({ ...entry, appliedAt: new Date().toISOString() });
  log = log.slice(-200);

  await admin.graphql(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, {
    variables: {
      metafields: [{
        ownerId: shopId,
        namespace: EXTRA_SETTINGS_NAMESPACE,
        key: AUDIT_LOG_KEY,
        type: "json",
        value: JSON.stringify(log),
      }],
    },
  });
}

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop}`);

  const contractId = payload?.admin_graphql_api_id || payload?.id;
  console.log("New subscription contract created:", { contractId });

  if (!contractId) {
    console.log("[webhook] No contract id in payload — skipping preview.");
    return new Response(null, { status: 200 });
  }

  const normalizedContractId = String(contractId).startsWith("gid://")
    ? contractId
    : `gid://shopify/SubscriptionContract/${contractId}`;

  try {
    const preview = await getContractPreview(admin, normalizedContractId);

    if (preview?.planGroup?.id && preview?.nextOrder?.cycleIndex != null) {
      const shopId = await getShopId(admin);

      const metaRes = await admin.graphql(`
        query {
          shop {
            metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${metaKeyForGroup(preview.planGroup.id)}") {
              value
            }
          }
        }
      `);
      const metaData = await metaRes.json();
      const raw = metaData.data?.shop?.metafield?.value;
      let settings = null;
      if (raw) {
        try { settings = JSON.parse(raw); } catch { settings = null; }
      }

      const cycleIndex = preview.nextOrder.cycleIndex;
      const actionsForThisCycle = settings ? collectActionsForCycle(settings, cycleIndex) : [];

      if (actionsForThisCycle.length > 0) {
        const marker = `${normalizedContractId}:${cycleIndex}`;

        // Guard against duplicate/redelivered webhook events (Shopify retries
        // on slow responses, dev-server restarts, etc.) reprocessing the same
        // cycle. Without this check the webhook re-runs every action on every
        // redelivery — harmless for idempotent actions like quantity change,
        // but not for actions like adding a discount, and definitely not safe
        // if a CHARGE action is ever added to this flow.
        const alreadyProcessed = await isCycleProcessed(admin, marker);

        if (alreadyProcessed) {
          console.log(
            `[webhook] Cycle ${cycleIndex} for ${normalizedContractId} already processed — skipping duplicate webhook delivery.`
          );
        } else {
          try {
            await applyActionsToCycle(admin, normalizedContractId, cycleIndex, actionsForThisCycle);
            await markCycleProcessed(admin, shopId, marker);
            await appendAuditLog(admin, shopId, {
              contractId: normalizedContractId,
              groupId: preview.planGroup.id,
              cycleIndex,
              actions: actionsForThisCycle.map((a) => a.type),
              status: "success",
              source: "webhook:contract_create",
            });
            console.log(`[webhook] Applied actions to cycle ${cycleIndex} for ${normalizedContractId} at creation time.`);
          } catch (err) {
            await appendAuditLog(admin, shopId, {
              contractId: normalizedContractId,
              groupId: preview.planGroup.id,
              cycleIndex,
              actions: actionsForThisCycle.map((a) => a.type),
              status: "failed",
              source: "webhook:contract_create",
              error: String(err?.message || err),
            });
            console.error(`[webhook] Failed to apply actions at creation time for ${normalizedContractId}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error("[webhook] Failed to build contract preview:", err);
  }

  return new Response(null, { status: 200 });
};