import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

const EXTRA_SETTINGS_NAMESPACE = "subscription_app";

const PROCESSED_CYCLES_KEY = "processed_billing_cycles";
function metaKeyForGroup(groupId) {
  const numericId = groupId.split("/").pop();
  return `extra_settings_${numericId}`;
}

function formatDate(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatFrequency(billingPolicy) {
  const interval = billingPolicy?.interval;
  const count = billingPolicy?.intervalCount;
  if (!interval || !count) return "-";
  const unit = interval.toLowerCase();
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

function formatMoney(amount, currencyCode) {
  const num = parseFloat(amount || "0");
  const formatted = num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currencyCode === "INR" ? `₹${formatted}` : `${formatted} ${currencyCode || ""}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const numericId = params.id;
  const contractId = numericId.startsWith("gid://")
    ? numericId
    : `gid://shopify/SubscriptionContract/${numericId}`;

  const contractRes = await admin.graphql(`
    query getContractDetail($id: ID!) {
      subscriptionContract(id: $id) {
        id
        status
        createdAt
        updatedAt
        nextBillingDate
        note
        customer {
          displayName
        }
        deliveryPrice {
          amount
          currencyCode
        }
        deliveryMethod {
          ... on SubscriptionDeliveryMethodShipping {
            shippingOption {
              title
            }
          }
        }
        billingPolicy {
          interval
          intervalCount
          minCycles
          maxCycles
        }
        deliveryPolicy {
          interval
          intervalCount
        }
        lines(first: 10) {
          edges {
            node {
              id
              title
              quantity
              sellingPlanId
              currentPrice {
                amount
                currencyCode
              }
              lineDiscountedPrice {
                amount
                currencyCode
              }
            }
          }
        }
        billingAttempts(first: 20, reverse: true) {
          edges {
            node {
              id
              ready
              errorMessage
              order {
                id
                name
              }
            }
          }
        }
        discounts(first: 20) {
          edges {
            node {
              ... on SubscriptionManualDiscount {
                id
                title
                recurringCycleLimit
                value {
                  ... on SubscriptionDiscountPercentageValue {
                    percentage
                  }
                  ... on SubscriptionDiscountFixedAmountValue {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { id: contractId } });

  const contractData = await contractRes.json();
  const contract = contractData.data?.subscriptionContract;

  if (!contract) {
    return { notFound: true, contractId };
  }

  // ── SubscriptionContract does NOT implement Shopify's HasMetafields
  // interface — there is no `metafield`/`metafields` field on this type at
  // all (confirmed against the Admin API schema), so metafields can't be
  // read OR written directly on a contract. Same limitation the extraSettings
  // (per-selling-plan-group) and processed_billing_cycles markers already
  // work around elsewhere in this file: store a JSON blob on the shop,
  // keyed by contract id, instead. ──
  const { internalNote: internalNoteFromContract, customerNote: customerNoteFromContract } =
    await getContractNotes(admin, contractId);

  // ── Resolve current cycle index using "now", same fix as billing-preview
  // (contract.nextBillingDate can lag after a cycle is billed). ──
  let currentCycleIndex = null;
  try {
    const nowIso = new Date().toISOString();
    const cycleRes = await admin.graphql(`
      query getCycleByDate($contractId: ID!, $date: DateTime!) {
        subscriptionBillingCycle(
          billingCycleInput: { contractId: $contractId, selector: { date: $date } }
        ) {
          cycleIndex
        }
      }
    `, { variables: { contractId, date: nowIso } });
    const cycleData = await cycleRes.json();
    currentCycleIndex = cycleData.data?.subscriptionBillingCycle?.cycleIndex ?? null;
  } catch {
    currentCycleIndex = null;
  }

  // ── Build the "upcoming orders" list — every remaining cycle from the
  // current one up to maxCycles (like Kaching's full upcoming list),
  // each fetched individually by index. Capped at 30 as a safety limit so
  // an unlimited (no maxCycles) contract doesn't fire unbounded queries. ──
  const upcomingOrders = [];
  if (currentCycleIndex != null) {
    const maxCycles = contract.billingPolicy?.maxCycles || null;
    const lastIndex = maxCycles
      ? Math.min(maxCycles, currentCycleIndex + 30)
      : currentCycleIndex + 30;
    for (let idx = currentCycleIndex; idx <= lastIndex; idx++) {
      try {
        const res = await admin.graphql(`
          query getCycle($contractId: ID!, $index: Int!) {
            subscriptionBillingCycle(
              billingCycleInput: { contractId: $contractId, selector: { index: $index } }
            ) {
              cycleIndex
              billingAttemptExpectedDate
              skipped
            }
          }
        `, { variables: { contractId, index: idx } });
        const data = await res.json();
        const cycle = data.data?.subscriptionBillingCycle;
        if (cycle) upcomingOrders.push(cycle);
      } catch {
        // skip this one, keep going
      }
    }
  }

  // ── Automatic actions configured for this contract's plan (product
  // swap / qty change / shipping discount), pulled the same way as
  // getContractPreview. ──
  const sellingPlanId = contract.lines.edges[0]?.node?.sellingPlanId;
  let groupId = null;
  let groupName = null;
  let extraSettings = null;
  if (sellingPlanId) {
    const groupsRes = await admin.graphql(`
      query {
        sellingPlanGroups(first: 50) {
          edges { node { id name sellingPlans(first: 20) { edges { node { id } } } } }
        }
      }
    `);
    const groupsData = await groupsRes.json();
    const groups = groupsData.data.sellingPlanGroups.edges.map((e) => e.node);
    for (const group of groups) {
      if (group.sellingPlans.edges.some(({ node }) => node.id === sellingPlanId)) {
        groupId = group.id;
        groupName = group.name;
        break;
      }
    }
    if (groupId) {
      const metaRes = await admin.graphql(`
        query {
          shop {
            metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${metaKeyForGroup(groupId)}") {
              value
            }
          }
        }
      `);
      const metaData = await metaRes.json();
      const raw = metaData.data?.shop?.metafield?.value;
      if (raw) {
        try { extraSettings = JSON.parse(raw); } catch { extraSettings = null; }
      }
    }
  }

  const billingAttempts = (contract.billingAttempts?.edges || []).map((e) => e.node);
  const discounts = (contract.discounts?.edges || []).map((e) => e.node).filter(Boolean);

  return {
    contract: {
      ...contract,
      lines: contract.lines.edges.map((e) => e.node),
    },
    currentCycleIndex,
    upcomingOrders,
    billingAttempts,
    planGroupName: groupName,
    extraSettings,
    discounts,
    internalNote: internalNoteFromContract,
    customerNote: customerNoteFromContract,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// FORCE PATH: deletes any pending billing-cycle-scoped edits (current +
// future) on this contract, which is what unblocks subscriptionContractUpdate.
// This reverts those cycles' schedule/contract info back to the base
// contract — meaning any shipping discount / qty change / product swap that
// was already applied to an upcoming cycle gets wiped along with it. We also
// clear our own "already processed" markers for this contract so the cron
// knows to reapply those automatic actions once that cycle becomes due
// again (same as how it normally handles cycle 2+).
// ─────────────────────────────────────────────────────────────────────────────
async function deletePendingCycleEdits(admin, contractId) {
  const res = await admin.graphql(`
    mutation deleteCycleEdits($contractId: ID!) {
      subscriptionBillingCycleEditsDelete(contractId: $contractId, targetSelection: ALL) {
        billingCycles { cycleIndex }
        userErrors { field message }
      }
    }
  `, { variables: { contractId } });
  const data = await res.json();
  const payload = data.data?.subscriptionBillingCycleEditsDelete;
  if (payload?.userErrors?.length) {
    return { error: payload.userErrors[0].message };
  }
  return { clearedCycles: (payload?.billingCycles || []).map((c) => c.cycleIndex) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract notes storage. SubscriptionContract has no metafield/metafields
// field in the Admin API — it doesn't implement HasMetafields — so notes
// can't live on the contract itself. Instead we keep one JSON blob on the
// shop (namespace: subscription_app, key: contract_notes) shaped like:
//   { "gid://shopify/SubscriptionContract/123": { internalNote, customerNote } }
// ─────────────────────────────────────────────────────────────────────────────
const CONTRACT_NOTES_KEY = "contract_notes";

async function getShopId(admin) {
  const res = await admin.graphql(`{ shop { id } }`);
  const data = await res.json();
  return data.data?.shop?.id;
}

async function getContractNotesMap(admin) {
  const res = await admin.graphql(`
    query {
      shop {
        metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${CONTRACT_NOTES_KEY}") {
          value
        }
      }
    }
  `);
  const data = await res.json();
  const raw = data.data?.shop?.metafield?.value;
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function getContractNotes(admin, contractId) {
  const map = await getContractNotesMap(admin);
  const entry = map[contractId] || {};
  return {
    internalNote: entry.internalNote || "",
    customerNote: entry.customerNote || "",
  };
}

async function setContractNote(admin, contractId, field, value) {
  const [map, shopId] = await Promise.all([getContractNotesMap(admin), getShopId(admin)]);
  if (!shopId) return { error: "Could not resolve shop id." };

  const existing = map[contractId] || {};
  map[contractId] = { ...existing, [field]: value };

  const res = await admin.graphql(`
    mutation setContractNotes($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, {
    variables: {
      metafields: [{
        ownerId: shopId,
        namespace: EXTRA_SETTINGS_NAMESPACE,
        key: CONTRACT_NOTES_KEY,
        type: "json",
        value: JSON.stringify(map),
      }],
    },
  });
  const data = await res.json();
  const errors = data.data?.metafieldsSet?.userErrors;
  if (errors?.length) return { error: errors[0].message };
  return { success: true };
}

async function clearProcessedCycleMarkers(admin, contractId) {
  const shopRes = await admin.graphql(`{ shop { id } }`);
  const shopData = await shopRes.json();
  const shopId = shopData.data?.shop?.id;
  if (!shopId) return;

  const metaRes = await admin.graphql(`
    query {
      shop {
        metafield(namespace: "${EXTRA_SETTINGS_NAMESPACE}", key: "${PROCESSED_CYCLES_KEY}") {
          value
        }
      }
    }
  `);
  const metaData = await metaRes.json();
  let markers = [];
  try {
    markers = JSON.parse(metaData.data?.shop?.metafield?.value || "[]");
  } catch {
    markers = [];
  }

  const prefix = `${contractId}:`;
  const filtered = markers.filter((m) => !m.startsWith(prefix));
  if (filtered.length === markers.length) return; // nothing to clear

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
        value: JSON.stringify(filtered),
      }],
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Opens a CONTRACT-level draft (subscriptionContractUpdate). Shopify refuses
// this if the contract has a billing-cycle-scoped edit (from
// subscriptionBillingCycleContractEdit — i.e. our automatic shipping
// discount / qty change / product swap actions) still pending on a current
// or upcoming cycle that hasn't billed yet. That's a real platform
// constraint, not a bug — the two draft mechanisms can't be open at once.
// We translate Shopify's raw error into something the merchant can actually
// act on, instead of surfacing the raw GraphQL error string.
// ─────────────────────────────────────────────────────────────────────────────
async function openContractDraft(admin, contractId) {
  const draftRes = await admin.graphql(`
    mutation openContractDraft($contractId: ID!) {
      subscriptionContractUpdate(contractId: $contractId) {
        draft { id }
        userErrors { field message }
      }
    }
  `, { variables: { contractId } });
  const draftData = await draftRes.json();
  const payload = draftData.data?.subscriptionContractUpdate;
  const rawError = payload?.userErrors?.[0]?.message;

  if (rawError) {
    if (/current or upcoming billing cycle contract edit/i.test(rawError)) {
      return {
        error:
          "This subscription has a pending scheduled change on an upcoming order (e.g. an automatic shipping discount, quantity change, or product swap) that hasn't been charged yet. Discounts that apply across future cycles can only be added once that pending change is processed — please try again after the next order is billed.",
        code: "PENDING_CYCLE_EDIT",
      };
    }
    return { error: rawError };
  }
  if (!payload?.draft?.id) {
    return { error: "Could not open a draft for this contract." };
  }
  return { draftId: payload.draft.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action — pause / cancel contract, skip / unskip / charge-now a cycle
// ─────────────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const numericId = params.id;
  const contractId = numericId.startsWith("gid://")
    ? numericId
    : `gid://shopify/SubscriptionContract/${numericId}`;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "pause") {
    const res = await admin.graphql(`
      mutation pause($contractId: ID!) {
        subscriptionContractPause(subscriptionContractId: $contractId) {
          contract { id status }
          userErrors { field message }
        }
      }
    `, { variables: { contractId } });
    const data = await res.json();
    const errors = data.data?.subscriptionContractPause?.userErrors;
    if (errors?.length) return { error: errors[0].message };
    return { success: "Subscription paused." };
  }

  if (intent === "cancel") {
    const res = await admin.graphql(`
      mutation cancel($contractId: ID!) {
        subscriptionContractCancel(subscriptionContractId: $contractId) {
          contract { id status }
          userErrors { field message }
        }
      }
    `, { variables: { contractId } });
    const data = await res.json();
    const errors = data.data?.subscriptionContractCancel?.userErrors;
    if (errors?.length) return { error: errors[0].message };
    return { success: "Subscription cancelled." };
  }

  if (intent === "activate") {
    const res = await admin.graphql(`
      mutation activate($contractId: ID!) {
        subscriptionContractActivate(subscriptionContractId: $contractId) {
          contract { id status }
          userErrors { field message }
        }
      }
    `, { variables: { contractId } });
    const data = await res.json();
    const errors = data.data?.subscriptionContractActivate?.userErrors;
    if (errors?.length) return { error: errors[0].message };
    return { success: "Subscription resumed." };
  }

  if (intent === "skipCycle" || intent === "unskipCycle") {
    const index = parseInt(formData.get("cycleIndex"));
    const mutationName = intent === "skipCycle" ? "subscriptionBillingCycleSkip" : "subscriptionBillingCycleUnskip";
    const res = await admin.graphql(`
      mutation cycleSkip($contractId: ID!, $index: Int!) {
        ${mutationName}(
          billingCycleInput: { contractId: $contractId, selector: { index: $index } }
        ) {
          billingCycle { cycleIndex skipped }
          userErrors { field message }
        }
      }
    `, { variables: { contractId, index } });
    const data = await res.json();
    const payload = data.data?.[mutationName];
    if (payload?.userErrors?.length) return { error: payload.userErrors[0].message };
    return { success: intent === "skipCycle" ? "Order skipped." : "Skip undone." };
  }

  if (intent === "rescheduleCycle") {
    const index = parseInt(formData.get("cycleIndex"));
    const newDate = formData.get("newDate"); // expected as YYYY-MM-DD from <input type="date">
    if (!newDate) return { error: "Pick a date first." };

    // Reuse the current expected time-of-day so we only change the date,
    // not the time — the date input only gives us a calendar day.
    const cycleLookupRes = await admin.graphql(`
      query getCycle($contractId: ID!, $index: Int!) {
        subscriptionBillingCycle(
          billingCycleInput: { contractId: $contractId, selector: { index: $index } }
        ) {
          billingAttemptExpectedDate
        }
      }
    `, { variables: { contractId, index } });
    const cycleLookupData = await cycleLookupRes.json();
    const existing = cycleLookupData.data?.subscriptionBillingCycle?.billingAttemptExpectedDate;
    const timePart = existing ? existing.split("T")[1] : "00:00:00.000Z";
    const newDateTime = `${newDate}T${timePart}`;

    const res = await admin.graphql(`
      mutation rescheduleCycle($contractId: ID!, $index: Int!, $newDate: DateTime!) {
        subscriptionBillingCycleScheduleEdit(
          billingCycleInput: { contractId: $contractId, selector: { index: $index } }
          input: { billingDate: $newDate, reason: BUYER_INITIATED }
        ) {
          billingCycle { cycleIndex billingAttemptExpectedDate }
          userErrors { field message }
        }
      }
    `, { variables: { contractId, index, newDate: newDateTime } });

    const data = await res.json();
    const payload = data.data?.subscriptionBillingCycleScheduleEdit;
    if (payload?.userErrors?.length) return { error: payload.userErrors[0].message };
    return { success: "Order rescheduled." };
  }

  if (intent === "addDiscount") {
    const title = (formData.get("title") || "Discount").toString();
    const discountType = formData.get("discountType"); // "PERCENTAGE" | "FIXED_AMOUNT"
    const value = formData.get("value");
    const isLimited = formData.get("isLimited") === "true";
    const cycleLimit = isLimited ? parseInt(formData.get("cycleLimit")) : null; // null = unlimited / persistent (omitted from the mutation input)
    const force = formData.get("force") === "true";

    if (!value || isNaN(parseFloat(value))) {
      return { error: "Enter a valid discount value." };
    }
    if (isLimited && (!cycleLimit || cycleLimit < 1)) {
      return { error: "Enter how many cycles the discount should apply for." };
    }

    if (force) {
      const deleted = await deletePendingCycleEdits(admin, contractId);
      if (deleted.error) return { error: deleted.error };
      await clearProcessedCycleMarkers(admin, contractId);
    }

    // Step 1: open a CONTRACT-level draft (not a billing-cycle-scoped draft —
    // this is what makes the discount persist across future cycles instead
    // of only applying to one specific cycle).
    const opened = await openContractDraft(admin, contractId);
    if (opened.error) return { error: opened.error, code: opened.code };
    const draftId = opened.draftId;

    // Step 2: add the discount to the draft.
    const discountValueInput =
      discountType === "FIXED_AMOUNT"
        ? { fixedAmount: { amount: parseFloat(value) } }
        : { percentage: Math.round(parseFloat(value)) };

    const addRes = await admin.graphql(`
      mutation addDiscount($draftId: ID!, $input: SubscriptionManualDiscountInput!) {
        subscriptionDraftDiscountAdd(draftId: $draftId, input: $input) {
          discountAdded { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        draftId,
        input: {
          title,
          entitledLines: { all: true }, // applies to all line items
          // Shopify requires recurringCycleLimit to be either omitted/null
          // (persists indefinitely until removed) or a positive integer —
          // sending 0 is rejected, unlike what some docs suggest.
          ...(isLimited ? { recurringCycleLimit: cycleLimit } : {}),
          value: discountValueInput,
        },
      },
    });
    const addData = await addRes.json();
    const addPayload = addData.data?.subscriptionDraftDiscountAdd;
    if (addPayload?.userErrors?.length) return { error: addPayload.userErrors[0].message };

    // Step 3: commit the draft so it takes effect on future billing cycles.
    const commitRes = await admin.graphql(`
      mutation commitDraft($draftId: ID!) {
        subscriptionDraftCommit(draftId: $draftId) {
          userErrors { field message }
        }
      }
    `, { variables: { draftId } });
    const commitData = await commitRes.json();
    const commitErrors = commitData.data?.subscriptionDraftCommit?.userErrors;
    if (commitErrors?.length) return { error: commitErrors[0].message };

    return {
      success: force
        ? "Discount added. Note: any automatic shipping discount, quantity change, or product swap on the upcoming cycle was cleared and will reapply automatically closer to that order's billing date."
        : "Discount added.",
    };
  }

  if (intent === "removeDiscount") {
    const discountId = formData.get("discountId");
    if (!discountId) return { error: "Missing discount id." };

    const opened = await openContractDraft(admin, contractId);
    if (opened.error) return { error: opened.error };
    const draftId = opened.draftId;

    const removeRes = await admin.graphql(`
      mutation removeDiscount($draftId: ID!, $discountId: ID!) {
        subscriptionDraftDiscountRemove(draftId: $draftId, discountId: $discountId) {
          userErrors { field message }
        }
      }
    `, { variables: { draftId, discountId } });
    const removeData = await removeRes.json();
    const removeErrors = removeData.data?.subscriptionDraftDiscountRemove?.userErrors;
    if (removeErrors?.length) return { error: removeErrors[0].message };

    const commitRes = await admin.graphql(`
      mutation commitDraft($draftId: ID!) {
        subscriptionDraftCommit(draftId: $draftId) {
          userErrors { field message }
        }
      }
    `, { variables: { draftId } });
    const commitData = await commitRes.json();
    const commitErrors = commitData.data?.subscriptionDraftCommit?.userErrors;
    if (commitErrors?.length) return { error: commitErrors[0].message };

    return { success: "Discount removed." };
  }

  if (intent === "saveInternalNote" || intent === "saveCustomerNote") {
    // SubscriptionContract can't hold metafields directly (no HasMetafields
    // support) — notes are stored in a shop-level JSON blob keyed by
    // contract id instead. See getContractNotes/setContractNote above.
    const field = intent === "saveInternalNote" ? "internalNote" : "customerNote";
    const noteValue = (formData.get("note") || "").toString();

    const result = await setContractNote(admin, contractId, field, noteValue);
    if (result.error) return { error: result.error };

    return { success: intent === "saveInternalNote" ? "Internal note saved." : "Customer note saved." };
  }

  if (intent === "chargeNow") {
    const index = parseInt(formData.get("cycleIndex"));
    const res = await admin.graphql(`
      mutation chargeNow($contractId: ID!, $index: Int!) {
        subscriptionBillingCycleCharge(
          subscriptionContractId: $contractId
          billingCycleSelector: { index: $index }
        ) {
          subscriptionBillingAttempt { id ready }
          userErrors { field message }
        }
      }
    `, { variables: { contractId, index } });
    const data = await res.json();
    const payload = data.data?.subscriptionBillingCycleCharge;
    if (payload?.userErrors?.length) return { error: payload.userErrors[0].message };
    return { success: "Charge triggered." };
  }

  return { error: "Unknown action." };
};

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function SubscriptionDetailPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  // FIX: these were being used below (setEditingCycle / setPendingDate)
  // without ever being declared, which throws a ReferenceError as soon as
  // this component renders with any upcoming orders present.
  const [editingCycle, setEditingCycle] = useState(null);
  const [pendingDate, setPendingDate] = useState("");
  const [showDiscountForm, setShowDiscountForm] = useState(false);
  const [discountTitle, setDiscountTitle] = useState("");
  const [discountType, setDiscountType] = useState("PERCENTAGE");
  const [discountValue, setDiscountValue] = useState("");
  const [isLimited, setIsLimited] = useState(false);
  const [cycleLimit, setCycleLimit] = useState("");

  if (data.notFound) {
    return (
      <s-page heading="Subscription not found">
        <s-section>
          <s-text tone="subdued">No contract found for {data.contractId}.</s-text>
        </s-section>
      </s-page>
    );
  }

  const { contract, upcomingOrders, billingAttempts, planGroupName, extraSettings, discounts, currentCycleIndex, internalNote, customerNote } = data;
  const numericId = contract.id.split("/").pop();
  const isPending = fetcher.state !== "idle";

  // ── Internal note is always editable (matches the Kaching-style layout —
  // a textarea with Save/Cancel, Save disabled until the draft differs from
  // what's actually saved). Customer note is read-only until you hit edit,
  // plus a delete icon to clear it outright. Drafts re-sync from loader data
  // whenever it changes (e.g. after a successful save triggers revalidation),
  // but typing mid-edit won't get clobbered since the loader value itself
  // only changes once the save actually lands. ──
  const [internalNoteDraft, setInternalNoteDraft] = useState(internalNote || "");
  const [customerNoteDraft, setCustomerNoteDraft] = useState(customerNote || "");
  const [editingCustomerNote, setEditingCustomerNote] = useState(false);

  useEffect(() => {
    setInternalNoteDraft(internalNote || "");
  }, [internalNote]);

  useEffect(() => {
    setCustomerNoteDraft(customerNote || "");
    setEditingCustomerNote(false);
  }, [customerNote]);

  const subtotal = contract.lines.reduce(
    (sum, l) => sum + parseFloat(l.currentPrice?.amount || "0") * l.quantity,
    0
  );
  const currency = contract.lines[0]?.currentPrice?.currencyCode || "INR";
  const shippingAmount = parseFloat(contract.deliveryPrice?.amount || "0");
  const total = subtotal + shippingAmount;

  const runIntent = (intent, extra = {}) => {
    fetcher.submit({ intent, ...extra }, { method: "post" });
  };

  // FIX: opening the edit row now seeds pendingDate from that cycle's own
  // expected date, instead of leaving whatever was left over from the last
  // cycle someone edited. Closing (toggling back) clears it.
  const toggleEditCycle = (cycle) => {
    const opening = editingCycle === cycle.cycleIndex ? null : cycle.cycleIndex;
    setEditingCycle(opening);
    setPendingDate(opening !== null ? (cycle.billingAttemptExpectedDate?.split("T")[0] || "") : "");
  };

  const resetDiscountForm = () => {
    setDiscountTitle("");
    setDiscountType("PERCENTAGE");
    setDiscountValue("");
    setIsLimited(false);
    setCycleLimit("");
    setShowDiscountForm(false);
  };

  // Only close/clear the discount form once the action actually succeeds —
  // if it fails (e.g. the pending-cycle-edit conflict), we keep the entered
  // values in state so a "Force add" retry can resubmit them.
  useEffect(() => {
    if (fetcher.data?.success && showDiscountForm) {
      resetDiscountForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const submitAddDiscount = (force = false) => {
    runIntent("addDiscount", {
      title: discountTitle || (discountType === "PERCENTAGE" ? `${discountValue}% off` : `${discountValue} off`),
      discountType,
      value: discountValue,
      isLimited: isLimited ? "true" : "false",
      cycleLimit: isLimited ? cycleLimit : "",
      force: force ? "true" : "false",
    });
    // Deliberately NOT resetting the form here — fetcher.submit is async, so
    // we don't know success/failure yet. If this hits the pending-cycle-edit
    // conflict, we want discountTitle/discountType/discountValue/etc still
    // in state so the "Force add" retry button can resubmit the same values.
    // The form is reset separately once fetcher.data confirms success.
  };

  const formatDiscountLabel = (d) => {
    const val = d.value?.percentage != null
      ? `${d.value.percentage}% off`
      : d.value?.amount
        ? `${formatMoney(d.value.amount.amount, d.value.amount.currencyCode)} off`
        : "Discount";
    const scope = !d.recurringCycleLimit || d.recurringCycleLimit === 0
      ? "every future order"
      : `next ${d.recurringCycleLimit} cycle${d.recurringCycleLimit === 1 ? "" : "s"}`;
    return `${d.title ? `${d.title} — ` : ""}${val}, applies to ${scope}`;
  };

  return (
    <s-page heading={`#${numericId}`}>
      <s-button slot="header-actions" onClick={() => navigate("/app/subscriptionPage")}>
        ← Back to list
      </s-button>

      {fetcher.data?.success && (
        <s-banner tone="success">{fetcher.data.success}</s-banner>
      )}
      {fetcher.data?.error && (
        <s-banner tone="critical">{fetcher.data.error}</s-banner>
      )}

      <s-section heading="Status">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={contract.status === "ACTIVE" ? "success" : "warning"}>
            {contract.status}
          </s-badge>
          <s-text tone="subdued">Created {formatDate(contract.createdAt)}</s-text>
          {currentCycleIndex != null && (
            <s-text tone="subdued">Current billing cycle: {currentCycleIndex}</s-text>
          )}
        </s-stack>
        <s-stack direction="inline" gap="tight" style={{ marginTop: "12px" }}>
          {contract.status === "ACTIVE" && (
            <s-button onClick={() => runIntent("pause")} disabled={isPending}>
              Pause
            </s-button>
          )}
          {contract.status === "PAUSED" && (
            <s-button onClick={() => runIntent("activate")} disabled={isPending}>
              Resume
            </s-button>
          )}
          {contract.status !== "CANCELLED" && (
            <s-button tone="critical" onClick={() => runIntent("cancel")} disabled={isPending}>
              Cancel subscription
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Subscription details">
        {contract.lines.map((line) => (
          <s-stack key={line.id} direction="inline" justifyContent="space-between" style={{ marginBottom: "8px" }}>
            <s-text>{line.title} × {line.quantity}</s-text>
            <s-text>{formatMoney((parseFloat(line.currentPrice?.amount || "0") * line.quantity).toString(), line.currentPrice?.currencyCode)}</s-text>
          </s-stack>
        ))}
        <s-stack direction="inline" gap="loose" style={{ marginTop: "12px" }}>
          <s-text tone="subdued">Delivery: {formatFrequency(contract.deliveryPolicy)}</s-text>
          <s-text tone="subdued">Billing: {formatFrequency(contract.billingPolicy)}</s-text>
        </s-stack>
        {planGroupName && <s-text tone="subdued">Plan: {planGroupName}</s-text>}
      </s-section>

      <s-section heading="Payment summary">
        <s-stack direction="inline" justifyContent="space-between">
          <s-text>Subtotal</s-text>
          <s-text>{formatMoney(subtotal.toString(), currency)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          <s-text>Shipping{contract.deliveryMethod?.shippingOption?.title ? ` (${contract.deliveryMethod.shippingOption.title})` : ""}</s-text>
          <s-text>{formatMoney(shippingAmount.toString(), contract.deliveryPrice?.currencyCode || currency)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          <s-text fontWeight="bold">Total</s-text>
          <s-text fontWeight="bold">{formatMoney(total.toString(), currency)}</s-text>
        </s-stack>
      </s-section>

      {extraSettings && (
        <s-section heading="Automatic actions">
          {extraSettings.shippingDiscount?.enabled && (
            <s-text>🚚 Shipping discount: {extraSettings.shippingDiscount.value} ({extraSettings.shippingDiscount.type}) after cycle {extraSettings.shippingDiscount.after}</s-text>
          )}
          {extraSettings.quantityChange?.enabled && (
            <s-text>📦 Quantity change: {extraSettings.quantityChange.value} after cycle {extraSettings.quantityChange.after}</s-text>
          )}
          {(extraSettings.automaticActions || []).map((a, i) => (
            <s-text key={i}>
              🔄 {a.type}{a.variantTitle ? ` → ${a.variantTitle}` : ""} after cycle {a.afterCycle}
            </s-text>
          ))}
          {!extraSettings.shippingDiscount?.enabled &&
            !extraSettings.quantityChange?.enabled &&
            (extraSettings.automaticActions || []).length === 0 && (
              <s-text tone="subdued">No automatic actions configured.</s-text>
            )}
        </s-section>
      )}

      <s-section heading="Discounts">
        {discounts && discounts.length > 0 ? (
          discounts.map((d) => (
            <s-stack key={d.id} direction="inline" justifyContent="space-between" alignItems="center" style={{ marginBottom: "8px" }}>
              <s-text>{formatDiscountLabel(d)}</s-text>
              <s-button
                tone="critical"
                onClick={() => runIntent("removeDiscount", { discountId: d.id })}
                disabled={isPending}
              >
                Remove
              </s-button>
            </s-stack>
          ))
        ) : (
          <s-text tone="subdued">No discounts applied.</s-text>
        )}

        {!showDiscountForm ? (
          <s-button onClick={() => setShowDiscountForm(true)} disabled={isPending} style={{ marginTop: "12px" }}>
            Add a discount
          </s-button>
        ) : (
          <div
            style={{
              marginTop: "12px",
              padding: "16px",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              maxWidth: "420px",
            }}
          >
            <div>
              <label style={{ fontSize: "13px", fontWeight: 500, display: "block", marginBottom: "4px" }}>
                Discount name
              </label>
              <input
                type="text"
                placeholder="Enter discount name"
                value={discountTitle}
                onChange={(e) => setDiscountTitle(e.target.value)}
                style={{ width: "100%", padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px" }}
              />
            </div>

            <div>
              <label style={{ fontSize: "13px", fontWeight: 500, display: "block", marginBottom: "4px" }}>
                Discount type
              </label>
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value)}
                style={{ width: "100%", padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px" }}
              >
                <option value="PERCENTAGE">Percentage</option>
                <option value="FIXED_AMOUNT">Fixed amount</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: "13px", fontWeight: 500, display: "block", marginBottom: "4px" }}>
                {discountType === "PERCENTAGE" ? "Percentage (%)" : `Amount (${currency})`}
              </label>
              <input
                type="number"
                min="0"
                step={discountType === "PERCENTAGE" ? "1" : "0.01"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                style={{ width: "100%", padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px" }}
              />
            </div>

            <label style={{ fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}>
              <input
                type="checkbox"
                checked={isLimited}
                onChange={(e) => setIsLimited(e.target.checked)}
              />
              Limit the discount to a certain amount of cycles
            </label>

            {isLimited && (
              <div>
                <label style={{ fontSize: "13px", fontWeight: 500, display: "block", marginBottom: "4px" }}>
                  Number of cycles
                </label>
                <input
                  type="number"
                  min="1"
                  value={cycleLimit}
                  onChange={(e) => setCycleLimit(e.target.value)}
                  style={{ width: "100%", padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px" }}
                />
              </div>
            )}

            {!isLimited && (
              <s-text tone="subdued">This discount will apply to every future order until it's removed.</s-text>
            )}

            {fetcher.data?.error && fetcher.data?.code === "PENDING_CYCLE_EDIT" && (
              <div
                style={{
                  padding: "10px 12px",
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                  borderRadius: "6px",
                  fontSize: "13px",
                }}
              >
                <s-text>
                  Adding this now will clear the pending shipping discount / quantity change / product swap on the
                  upcoming order — it'll reapply automatically closer to that order's billing date.
                </s-text>
                <div style={{ marginTop: "8px" }}>
                  <s-button tone="critical" onClick={() => submitAddDiscount(true)} disabled={isPending}>
                    Force add anyway
                  </s-button>
                </div>
              </div>
            )}

            <s-stack direction="inline" gap="tight">
              <s-button onClick={resetDiscountForm}>Cancel</s-button>
              <s-button
                onClick={() => submitAddDiscount(false)}
                disabled={isPending || !discountValue || (isLimited && !cycleLimit)}
              >
                Apply discount
              </s-button>
            </s-stack>
          </div>
        )}
      </s-section>

      <s-section heading="Internal note">
        <s-text tone="subdued" style={{ display: "block", marginBottom: "8px" }}>
          Visible only to you and staff — never shown to the customer.
        </s-text>
        <textarea
          value={internalNoteDraft}
          onChange={(e) => setInternalNoteDraft(e.target.value)}
          placeholder="Add an internal note…"
          rows={3}
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            fontFamily: "inherit",
            fontSize: "13px",
            resize: "vertical",
          }}
        />
        <s-stack direction="inline" gap="tight" style={{ marginTop: "10px" }}>
          <s-button
            onClick={() => setInternalNoteDraft(internalNote || "")}
            disabled={isPending || internalNoteDraft === (internalNote || "")}
          >
            Cancel
          </s-button>
          <s-button
            onClick={() => runIntent("saveInternalNote", { note: internalNoteDraft })}
            disabled={isPending || internalNoteDraft === (internalNote || "")}
          >
            Save
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Customer note">
        {!editingCustomerNote ? (
          <>
            <s-stack direction="inline" justifyContent="space-between" alignItems="flex-start">
              {customerNote ? (
                <s-text style={{ whiteSpace: "pre-wrap" }}>{customerNote}</s-text>
              ) : (
                <s-text tone="subdued">No customer note yet.</s-text>
              )}
              <s-stack direction="inline" gap="tight">
                <s-button
                  onClick={() => {
                    setCustomerNoteDraft(customerNote || "");
                    setEditingCustomerNote(true);
                  }}
                  disabled={isPending}
                >
                  Edit
                </s-button>
                {customerNote && (
                  <s-button
                    tone="critical"
                    onClick={() => runIntent("saveCustomerNote", { note: "" })}
                    disabled={isPending}
                  >
                    Delete
                  </s-button>
                )}
              </s-stack>
            </s-stack>
          </>
        ) : (
          <>
            <s-text tone="subdued" style={{ display: "block", marginBottom: "8px" }}>
              Shown to the customer on their account / order communications.
            </s-text>
            <textarea
              value={customerNoteDraft}
              onChange={(e) => setCustomerNoteDraft(e.target.value)}
              placeholder="Add a note for the customer…"
              rows={3}
              autoFocus
              style={{
                width: "100%",
                padding: "8px 10px",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                fontFamily: "inherit",
                fontSize: "13px",
                resize: "vertical",
              }}
            />
            <s-stack direction="inline" gap="tight" style={{ marginTop: "10px" }}>
              <s-button
                onClick={() => {
                  setCustomerNoteDraft(customerNote || "");
                  setEditingCustomerNote(false);
                }}
                disabled={isPending}
              >
                Cancel
              </s-button>
              <s-button
                onClick={() => runIntent("saveCustomerNote", { note: customerNoteDraft })}
                disabled={isPending || customerNoteDraft === (customerNote || "")}
              >
                Save
              </s-button>
            </s-stack>
          </>
        )}
      </s-section>

      <s-section heading="Upcoming orders">
        {upcomingOrders.length === 0 ? (
          <s-text tone="subdued">No upcoming cycles found.</s-text>
        ) : (
          upcomingOrders.map((cycle) => (
            <div key={cycle.cycleIndex} style={{ marginBottom: "10px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text>
                  {formatDate(cycle.billingAttemptExpectedDate)}
                  {cycle.skipped ? " (skipped)" : ""}
                </s-text>
                <s-stack direction="inline" gap="tight">
                  <s-button
                    onClick={() => toggleEditCycle(cycle)}
                    disabled={isPending}
                  >
                    Edit
                  </s-button>
                  <s-button
                    onClick={() => runIntent(cycle.skipped ? "unskipCycle" : "skipCycle", { cycleIndex: cycle.cycleIndex })}
                    disabled={isPending}
                  >
                    {cycle.skipped ? "Unskip" : "Skip"}
                  </s-button>
                  <s-button
                    onClick={() => runIntent("chargeNow", { cycleIndex: cycle.cycleIndex })}
                    disabled={isPending || cycle.skipped}
                  >
                    Charge now
                  </s-button>
                </s-stack>
              </s-stack>

              {editingCycle === cycle.cycleIndex && (
                <div
                  style={{
                    marginTop: "8px",
                    padding: "12px",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  <label style={{ fontSize: "13px", fontWeight: 500 }}>Billing date</label>
                  <input
                    type="date"
                    value={pendingDate}
                    onChange={(e) => setPendingDate(e.target.value)}
                    style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px" }}
                  />
                  <s-button
                    onClick={() => {
                      runIntent("rescheduleCycle", {
                        cycleIndex: cycle.cycleIndex,
                        newDate: pendingDate,
                      });
                      setEditingCycle(null);
                      setPendingDate("");
                    }}
                    disabled={isPending || !pendingDate}
                  >
                    Save
                  </s-button>
                  <s-button onClick={() => { setEditingCycle(null); setPendingDate(""); }}>Cancel</s-button>
                </div>
              )}
            </div>
          ))
        )}
      </s-section>

      <s-section heading="Customer">
        <s-text fontWeight="bold">{contract.customer?.displayName || "-"}</s-text>
        <s-text tone="subdued" style={{ marginTop: "8px" }}>
          Shipping address available in Shopify's Customers admin page (requires protected customer data approval to show here).
        </s-text>
      </s-section>

      <s-section heading="Past orders">
        {billingAttempts.length === 0 ? (
          <s-text tone="subdued">No billing attempts yet.</s-text>
        ) : (
          billingAttempts.map((attempt) => (
            <s-stack key={attempt.id} direction="inline" justifyContent="space-between" style={{ marginBottom: "6px" }}>
              <s-text>
                {attempt.order?.name || "Pending"}
                {!attempt.ready && !attempt.order && " (processing)"}
                {attempt.errorMessage && ` — ${attempt.errorMessage}`}
              </s-text>
              {attempt.order && (
                <s-link href={`shopify:admin/orders/${attempt.order.id.split("/").pop()}`}>
                  View order
                </s-link>
              )}
            </s-stack>
          ))
        )}
      </s-section>

      {contract.note && (
        <s-section heading="Notes">
          <s-text>{contract.note}</s-text>
        </s-section>
      )}
    </s-page>
  );
}