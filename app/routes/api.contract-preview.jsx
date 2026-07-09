import { authenticate } from "../shopify.server";
import { getContractPreview } from "../lib/billing-preview.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  let contractId = url.searchParams.get("contractId");

  if (!contractId) {
    return new Response(
      JSON.stringify({ error: "Pass ?contractId=gid://shopify/SubscriptionContract/123 (or just the numeric id)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!contractId.startsWith("gid://")) {
    contractId = `gid://shopify/SubscriptionContract/${contractId}`;
  }

  try {
    const preview = await getContractPreview(admin, contractId);
    if (!preview) {
      return new Response(JSON.stringify({ error: "Contract not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Cycle-specific state ──
    // preview.lineItem comes from the contract's default lines, which do
    // NOT reflect a cycle-level draft edit until Shopify actually bills
    // that cycle. This just confirms the cycle's basic scheduling info —
    // Shopify's API doesn't expose committed cycle-level line items via
    // this read query, so use Shopify Admin UI (or the actual order once
    // billed) to visually confirm the swapped product.
    let cycleCommittedState = null;
    if (preview.nextOrder?.cycleIndex != null) {
      try {
        const cycleRes = await admin.graphql(`
          query getCycleDetails($contractId: ID!, $index: Int!) {
            subscriptionBillingCycle(
              billingCycleInput: { contractId: $contractId, selector: { index: $index } }
            ) {
              cycleIndex
              billingAttemptExpectedDate
              skipped
            }
          }
        `, { variables: { contractId, index: preview.nextOrder.cycleIndex } });

        const cycleData = await cycleRes.json();
        if (cycleData.errors) {
          cycleCommittedState = { error: cycleData.errors[0]?.message || "unknown GraphQL error" };
        } else {
          cycleCommittedState = cycleData.data?.subscriptionBillingCycle || null;
        }
      } catch (err) {
        cycleCommittedState = { error: String(err?.message || err) };
      }
    }

    return new Response(JSON.stringify({ ...preview, cycleCommittedState }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[contract-preview] failed:", err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};