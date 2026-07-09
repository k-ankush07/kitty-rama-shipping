import { unauthenticated } from "../shopify.server";
import prisma from "../db.server"; 

const EXTRA_SETTINGS_NAMESPACE = "subscription_app";

function metaKeyForGroup(groupId) {
  const numericId = groupId.split("/").pop();
  return `extra_settings_${numericId}`;
}

export const action = async ({ request }) => {
  const secret = request.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shops = await getShopsWithOfflineTokens();
  const results = [];

  for (const shop of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const shopResult = await processShop(admin);
      results.push({ shop, ...shopResult });
    } catch (err) {
      console.error(`[process-billing-cycles] failed for ${shop}:`, err);
      results.push({ shop, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ processed: results }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Reject GET/other verbs politely rather than 500ing.
export const loader = () => new Response("Use POST", { status: 405 });

// ─────────────────────────────────────────────────────────────────────────────
// Get list of shop domains this app is installed on (offline sessions).
// ─────────────────────────────────────────────────────────────────────────────
async function getShopsWithOfflineTokens() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return sessions.map((s) => s.shop);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a map of sellingPlanId -> sellingPlanGroupId, and groupId -> parsed
// extraSettings (from the Shop metafield).
// ─────────────────────────────────────────────────────────────────────────────
async function loadPlanGroupsAndSettings(admin) {
  const res = await admin.graphql(`
    query {
      shop { id }
      sellingPlanGroups(first: 50) {
        edges {
          node {
            id
            sellingPlans(first: 20) {
              edges { node { id } }
            }
          }
        }
      }
    }
  `);
  const data = await res.json();
  const shopId = data.data.shop.id;
  const groups = data.data.sellingPlanGroups.edges.map((e) => e.node);

  const sellingPlanIdToGroupId = new Map();
  for (const group of groups) {
    for (const { node: plan } of group.sellingPlans.edges) {
      sellingPlanIdToGroupId.set(plan.id, group.id);
    }
  }

  const metaRes = await admin.graphql(`
    query {
      shop {
        metafields(namespace: "${EXTRA_SETTINGS_NAMESPACE}", first: 250) {
          edges { node { key value } }
        }
      }
    }
  `);
  const metaData = await metaRes.json();
  const edges = metaData.data?.shop?.metafields?.edges || [];
  const metafieldsByKey = new Map(edges.map(({ node }) => [node.key, node.value]));

  return { shopId, sellingPlanIdToGroupId, metafieldsByKey };
}

function getExtraSettingsForGroup(metafieldsByKey, groupId) {
  const raw = metafieldsByKey.get(metaKeyForGroup(groupId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Track which (contractId, cycleIndex) pairs we've already edited, so we
// never double-apply an action if this route runs more than once before the
// cycle actually bills.
// ─────────────────────────────────────────────────────────────────────────────
const PROCESSED_CYCLES_KEY = "processed_billing_cycles";

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────
const AUDIT_LOG_KEY = "audit_log";

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

async function getProcessedCycles(admin, shopId) {
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
  const raw = data.data?.shop?.metafield?.value;
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function markCycleProcessed(admin, shopId, processedSet, marker) {
  processedSet.add(marker);
  const trimmed = Array.from(processedSet).slice(-500);
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

// ─────────────────────────────────────────────────────────────────────────────
// Main per-shop logic
// ─────────────────────────────────────────────────────────────────────────────
async function processShop(admin) {
  const { shopId, sellingPlanIdToGroupId, metafieldsByKey } = await loadPlanGroupsAndSettings(admin);
  const processedCycles = await getProcessedCycles(admin, shopId);

  // Active contracts — now also fetching nextBillingDate, needed for the
  // singular subscriptionBillingCycle(date selector) lookup below.
  const contractsRes = await admin.graphql(`
    query {
      subscriptionContracts(first: 50, query: "status:active") {
        edges {
          node {
            id
            nextBillingDate
            lines(first: 5) {
              edges { node { id sellingPlanId } }
            }
          }
        }
      }
    }
  `);
  const contractsData = await contractsRes.json();
  const contracts = contractsData.data.subscriptionContracts.edges.map((e) => e.node);

  const edited = [];
  const skipped = [];

  for (const contract of contracts) {
    const sellingPlanId = contract.lines.edges[0]?.node?.sellingPlanId;
    if (!sellingPlanId) {
      skipped.push({ contractId: contract.id, reason: "no selling plan" });
      continue;
    }

    const groupId = sellingPlanIdToGroupId.get(sellingPlanId);
    if (!groupId) {
      skipped.push({ contractId: contract.id, reason: "no matching plan group" });
      continue;
    }

    const settings = getExtraSettingsForGroup(metafieldsByKey, groupId);
    if (!settings) {
      skipped.push({ contractId: contract.id, reason: "no extra settings for group" });
      continue;
    }

    if (!contract.nextBillingDate) {
      skipped.push({ contractId: contract.id, reason: "no nextBillingDate" });
      continue;
    }

    // ── Find the upcoming cycle using the singular subscriptionBillingCycle
    // query with a date selector. ──
    const cycleRes = await admin.graphql(`
      query getCycleByDate($contractId: ID!, $date: DateTime!) {
        subscriptionBillingCycle(
          billingCycleInput: { contractId: $contractId, selector: { date: $date } }
        ) {
          cycleIndex
          billingAttemptExpectedDate
        }
      }
    `, { variables: { contractId: contract.id, date: contract.nextBillingDate } });

    const cycleData = await cycleRes.json();
    const cycle = cycleData.data?.subscriptionBillingCycle;
    if (!cycle) {
      skipped.push({ contractId: contract.id, reason: "no cycle found for nextBillingDate" });
      continue;
    }

    const cycleIndex = cycle.cycleIndex;
    const marker = `${contract.id}:${cycleIndex}`;
    if (processedCycles.has(marker)) {
      skipped.push({ contractId: contract.id, cycleIndex, reason: "already processed" });
      continue;
    }

    const actionsForThisCycle = collectActionsForCycle(settings, cycleIndex);
    if (actionsForThisCycle.length === 0) {
      skipped.push({ contractId: contract.id, cycleIndex, reason: "no actions configured for this cycle" });
      continue;
    }

    try {
      await applyActionsToCycle(admin, contract.id, cycleIndex, actionsForThisCycle);
      await markCycleProcessed(admin, shopId, processedCycles, marker);
      await appendAuditLog(admin, shopId, {
        contractId: contract.id,
        groupId,
        cycleIndex,
        actions: actionsForThisCycle.map((a) => a.type),
        status: "success",
      });
      edited.push({ contractId: contract.id, cycleIndex, actions: actionsForThisCycle.map((a) => a.type) });
    } catch (err) {
      await appendAuditLog(admin, shopId, {
        contractId: contract.id,
        groupId,
        cycleIndex,
        actions: actionsForThisCycle.map((a) => a.type),
        status: "failed",
        error: String(err?.message || err),
      });
      console.error(`[process-billing-cycles] failed for contract ${contract.id}:`, err);
      skipped.push({
        contractId: contract.id,
        cycleIndex,
        reason: "error during apply",
        error: String(err?.message || err),
      });
    }
  }

  return { contractsChecked: contracts.length, edited, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Given the extraSettings blob + a cycle index, work out what should fire
// on THIS specific cycle.
// ─────────────────────────────────────────────────────────────────────────────
function collectActionsForCycle(settings, cycleIndex) {
  const actions = [];
  if (!settings) return actions;

  if (settings.shippingDiscount?.enabled && settings.shippingDiscount.after === cycleIndex) {
    actions.push({ ...settings.shippingDiscount, type: "SHIPPING_DISCOUNT" }); 
  }

  if (settings.quantityChange?.enabled && settings.quantityChange.after === cycleIndex) {
    actions.push({ ...settings.quantityChange, type: "QUANTITY_CHANGE" }); 
  }

  for (const auto of settings.automaticActions || []) {
    if (auto.afterCycle === cycleIndex) {
      actions.push({ ...auto, type: auto.type }); 
    }
  }

  return actions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open a billing-cycle-scoped draft, apply each action to it, then commit.
// Every intermediate mutation now checks its own userErrors and throws if
// something failed — instead of silently continuing on to commit.
// ─────────────────────────────────────────────────────────────────────────────
async function applyActionsToCycle(admin, contractId, cycleIndex, actions) {
  // 1. Open the draft for this specific billing cycle.
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
    // ── QUANTITY_CHANGE ──
    if (action.type === "QUANTITY_CHANGE") {
      if (!lineId) {
        throw new Error("QUANTITY_CHANGE failed: no line found on draft to update");
      }
      const res = await admin.graphql(`
        mutation updateLineQty($draftId: ID!, $lineId: ID!, $qty: Int!) {
          subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: { quantity: $qty }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId, qty: action.value } });

      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineUpdate?.userErrors;
      if (errors?.length) {
        throw new Error(`QUANTITY_CHANGE failed: ${errors[0].message}`);
      }
    }

    // ── PRODUCT_SWAP / VARIANT_SWAP ──
    if (action.type === "PRODUCT_SWAP" || action.type === "VARIANT_SWAP") {
      if (!lineId) {
        throw new Error(`${action.type} failed: no line found on draft to update`);
      }
      if (!action.variantId) {
        // This is the "blank value" case seen in the preview — the action
        // was saved without a product/variant ever being selected in the UI.
        throw new Error(`${action.type} failed: no variantId configured for this action`);
      }
      const res = await admin.graphql(`
        mutation swapLine($draftId: ID!, $lineId: ID!, $variantId: ID!) {
          subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: { productVariantId: $variantId }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId, variantId: action.variantId } });

      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineUpdate?.userErrors;
      if (errors?.length) {
        throw new Error(`${action.type} failed: ${errors[0].message}`);
      }
    }

    // ── SHIPPING_DISCOUNT ──
    // NOTE: subscriptionDraftFreeShippingDiscountAdd makes shipping FREE
    // (100% off). It does not support setting an arbitrary fixed price such
    // as ₹50. If extraSettings.shippingDiscount.type is "PRICE" with a
    // non-zero value, this mutation cannot represent that correctly — it
    // will only ever make shipping free, not ₹50. This needs a different
    // mutation/approach if a fixed non-zero shipping price is required.
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
        throw new Error(`SHIPPING_DISCOUNT failed: ${errors[0].message}`);
      }
    }

    // ── REMOVE_PRODUCT / REMOVE_VARIANT ──
    if (action.type === "REMOVE_PRODUCT" || action.type === "REMOVE_VARIANT") {
      if (!lineId) {
        throw new Error(`${action.type} failed: no line found on draft to remove`);
      }
      const res = await admin.graphql(`
        mutation removeLine($draftId: ID!, $lineId: ID!) {
          subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, lineId } });

      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineRemove?.userErrors;
      if (errors?.length) {
        throw new Error(`${action.type} failed: ${errors[0].message}`);
      }
    }

    // ── ADD_PRODUCT ──
    if (action.type === "ADD_PRODUCT") {
      if (!action.variantId) {
        throw new Error("ADD_PRODUCT failed: no variantId configured for this action");
      }
      const res = await admin.graphql(`
        mutation addLine($draftId: ID!, $variantId: ID!, $qty: Int!) {
          subscriptionDraftLineAdd(draftId: $draftId, input: { productVariantId: $variantId, quantity: $qty }) {
            userErrors { field message }
          }
        }
      `, { variables: { draftId, variantId: action.variantId, qty: 1 } });

      const data = await res.json();
      const errors = data.data?.subscriptionDraftLineAdd?.userErrors;
      if (errors?.length) {
        throw new Error(`ADD_PRODUCT failed: ${errors[0].message}`);
      }
    }
  }

  // 2. Commit.
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