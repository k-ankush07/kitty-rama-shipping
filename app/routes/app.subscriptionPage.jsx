import { useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to turn raw GraphQL data into the same shape the table already
// expects (id, status, customerName, customerEmail, createdAt, updatedAt,
// nextOrderDate, product, price, frequency).
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return "";
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

// Shopify contract status enum values: ACTIVE, CANCELLED, EXPIRED,
// FAILED, PAUSED, STALE. Map to the same two-tone badge scheme the table
// already used (Active vs everything else shown as "Canceled").
function formatStatus(status) {
  if (!status) return "Unknown";
  if (status === "ACTIVE") return "Active";
  if (status === "CANCELLED") return "Canceled";
  // Anything else (PAUSED, EXPIRED, FAILED, STALE) still needs a label —
  // show it title-cased rather than silently lumping it in with Canceled.
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatFrequency(billingPolicy) {
  const interval = billingPolicy?.interval;
  const count = billingPolicy?.intervalCount;
  if (!interval || !count) return "-";

  const unit = interval.toLowerCase(); // day / week / month / year
  if (count === 1) {
    return `Every ${unit}`;
  }
  return `Every ${count} ${unit}${count > 1 ? "s" : ""}`;
}

function formatProductLabel(lines) {
  const edges = lines?.edges || [];
  if (edges.length === 0) return "-";
  if (edges.length === 1) return edges[0].node.title;
  return `${edges.length} products`;
}

function formatPrice(lines) {
  const edges = lines?.edges || [];
  if (edges.length === 0) return "-";
  // Sum quantity × currentPrice across all lines, same way the original
  // hardcoded data represented a single "price" column.
  let total = 0;
  let currency = null;
  for (const { node } of edges) {
    const amount = parseFloat(node.currentPrice?.amount || "0");
    const qty = node.quantity || 1;
    total += amount * qty;
    currency = currency || node.currentPrice?.currencyCode;
  }
  const formatted = total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency || ""}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — replaces the old hardcoded CONTRACTS array with a live GraphQL
// fetch of subscription contracts.
// ─────────────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(`
    query getSubscriptionContracts($first: Int!) {
      subscriptionContracts(first: $first, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            status
            createdAt
            updatedAt
            nextBillingDate
            customer {
              displayName
            }
            billingPolicy {
              interval
              intervalCount
            }
            lines(first: 10) {
              edges {
                node {
                  title
                  quantity
                  currentPrice {
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
  `, { variables: { first: 50 } });

  const data = await res.json();
  const edges = data.data?.subscriptionContracts?.edges || [];

  const contracts = edges.map(({ node }) => {
    const numericId = node.id.split("/").pop();
    const isActive = node.status === "ACTIVE";
    return {
      id: numericId,
      status: formatStatus(node.status),
      customerName: node.customer?.displayName || "-",
      createdAt: formatDate(node.createdAt),
      updatedAt: formatDate(node.updatedAt),
      nextOrderDate: isActive ? formatDate(node.nextBillingDate) : "",
      product: formatProductLabel(node.lines),
      price: formatPrice(node.lines),
      frequency: formatFrequency(node.billingPolicy),
    };
  });

  return { contracts };
};

export default function SubscriptionPage() {
  const { contracts } = useLoaderData();
  const [selected, setSelected] = useState([]);

  const toggle = (id) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <s-page heading="Subscription Contracts">
      <s-section>
        {contracts.length === 0 ? (
          <s-text tone="subdued">No subscription contracts found.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Contract</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Created at</s-table-header>
              <s-table-header>Updated at</s-table-header>
              <s-table-header>Next order date</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Delivery Frequency</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {contracts.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                   <s-link href={`/app/subscription/${c.id}`}>#{c.id}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={c.status === "Active" ? "success" : "warning"}>
                      {c.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontWeight="bold">{c.customerName}</s-text>
                  </s-table-cell>
                  <s-table-cell>{c.createdAt}</s-table-cell>
                  <s-table-cell>{c.updatedAt}</s-table-cell>
                  <s-table-cell>{c.nextOrderDate || "-"}</s-table-cell>
                  <s-table-cell>{c.product}</s-table-cell>
                  <s-table-cell>{c.price}</s-table-cell>
                  <s-table-cell>{c.frequency}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}