import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { useState } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(`
    query {
  sellingPlanGroups(first: 20) {
    edges {
      node {
        id
        name
        merchantCode
        products(first: 1) {
          edges {
            node {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        sellingPlans(first: 10) {
          edges {
            node {
              id
              name
              billingPolicy {
                ... on SellingPlanRecurringBillingPolicy {
                  interval
                  intervalCount
                }
              }
              pricingPolicies {
                ... on SellingPlanFixedPricingPolicy {
                  adjustmentType
                  adjustmentValue {
                    ... on SellingPlanPricingPolicyPercentageValue {
                      percentage
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
  `);

  const data = await res.json();
  return { sellingPlanGroups: data.data.sellingPlanGroups.edges.map((e) => e.node) };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

 if (intent === "create") {
  const name = formData.get("name");
  const interval = formData.get("interval");
  const intervalCount = parseInt(formData.get("intervalCount"));
  const discount = parseFloat(formData.get("discount"));

  const { session } = await authenticate.admin(request);

  const query = `
  mutation {
    sellingPlanGroupCreate(input: {
      name: ${JSON.stringify(name)}
      merchantCode: ${JSON.stringify(name.toLowerCase().replace(/\s/g, "-"))}
      options: ["Delivery every"]
      sellingPlansToCreate: [{
        name: "Every ${intervalCount} ${interval.toLowerCase()}"
        category: SUBSCRIPTION
        options: ["${intervalCount} ${interval}"]
        billingPolicy: { recurring: { interval: ${interval.toUpperCase()}, intervalCount: ${intervalCount} } }
        deliveryPolicy: { recurring: { interval: ${interval.toUpperCase()}, intervalCount: ${intervalCount} } }
        ${discount > 0 ? `pricingPolicies: [{ fixed: { adjustmentType: PERCENTAGE, adjustmentValue: { percentage: ${discount} } } }]` : ""}
      }]
    }, resources: {}) {
      sellingPlanGroup { id name }
      userErrors { field message }
    }
  }
`;


  const res = await fetch(
    `https://${session.shop}/admin/api/2025-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query }),
    }
  );

  const data = await res.json();
  console.log("RESPONSE:", JSON.stringify(data, null, 2));
  if (data.errors) return { error: data.errors[0].message };
  if (data.data.sellingPlanGroupCreate.userErrors.length > 0) {
    return { error: data.data.sellingPlanGroupCreate.userErrors[0].message };
  }
  return { success: "Plan created successfully!" };
}

  if (intent === "delete") {
    const planGroupId = formData.get("planGroupId");
    await admin.graphql(`
      mutation sellingPlanGroupDelete($id: ID!) {
        sellingPlanGroupDelete(id: $id) {
          deletedSellingPlanGroupId
          userErrors { field message }
        }
      }
    `, { variables: { id: planGroupId } });
    return { success: "Plan deleted!" };
  }

  return {};
}

export default function PlansPage() {
  const { sellingPlanGroups } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [showForm, setShowForm] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Selling Plans">
      {actionData?.success && <div style={styles.alert("success")}>{actionData.success}</div>}
      {actionData?.error && <div style={styles.alert("error")}>{actionData.error}</div>}

      <div style={{ marginBottom: "20px" }}>
        <button style={styles.primaryBtn} onClick={() => setShowForm(!showForm)}>
          {showForm ? "✕ Cancel" : "+ Create New Plan"}
        </button>
      </div>

      {showForm && (
        <div style={styles.formCard}>
          <h3 style={styles.formTitle}>Create Selling Plan</h3>
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div style={styles.formGrid}>
              <div style={styles.formGroup}>
                <label style={styles.label}>Plan Name</label>
                <input style={styles.input} name="name" placeholder="e.g. Monthly Subscription" required />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Billing Interval</label>
                <select style={styles.input} name="interval" required>
                  <option value="WEEK">Weekly</option>
                  <option value="MONTH">Monthly</option>
                  <option value="YEAR">Yearly</option>
                  <option value="DAY">Custom (Days)</option>
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Interval Count</label>
                <input style={styles.input} name="intervalCount" type="number" defaultValue={1} min={1} required />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Discount (%)</label>
                <input style={styles.input} name="discount" type="number" defaultValue={0} min={0} max={100} />
              </div>
            </div>
            <button style={styles.submitBtn} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Plan"}
            </button>
          </Form>
        </div>
      )}

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>All Selling Plan Groups ({sellingPlanGroups.length})</h2>
        {sellingPlanGroups.length === 0 ? (
          <div style={styles.empty}>No selling plans yet. Create your first one!</div>
        ) : (
          sellingPlanGroups.map((group) => (
            <div key={group.id} style={styles.planCard}>
              <div style={styles.planHeader}>
                <div>
                  <h3 style={styles.planName}>{group.name}</h3>
                  <span style={styles.planCode}>{group.merchantCode}</span>
                  <span style={styles.productCount}>
                    {group.products.edges.length}{group.products.pageInfo.hasNextPage ? "+" : ""} products
                  </span>
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="planGroupId" value={group.id} />
                  <button style={styles.deleteBtn} type="submit">🗑 Delete</button>
                </Form>
              </div>
              <div style={styles.plansInner}>
                {group.sellingPlans.edges.map(({ node: plan }) => (
                  <div key={plan.id} style={styles.planRow}>
                    <span>📅 {plan.name}</span>
                    <span style={styles.intervalBadge}>
                      {plan.billingPolicy?.intervalCount} × {plan.billingPolicy?.interval}
                    </span>
                    {plan.pricingPolicies?.[0]?.adjustmentValue?.percentage > 0 && (
                      <span style={styles.discountBadge}>
                        -{plan.pricingPolicies[0].adjustmentValue.percentage}% off
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </s-page>
  );
}

const styles = {
  alert: (type) => ({ padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", background: type === "success" ? "#d1fae5" : "#fee2e2", color: type === "success" ? "#065f46" : "#991b1b", fontWeight: "500" }),
  primaryBtn: { padding: "10px 20px", background: "#4f46e5", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "600" },
  formCard: { background: "white", borderRadius: "12px", padding: "24px", marginBottom: "24px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" },
  formTitle: { fontSize: "18px", fontWeight: "600", marginBottom: "16px" },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "16px", marginBottom: "16px" },
  formGroup: { display: "flex", flexDirection: "column", gap: "6px" },
  label: { fontSize: "14px", fontWeight: "500", color: "#374151" },
  input: { padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: "8px", fontSize: "14px" },
  submitBtn: { padding: "12px 24px", background: "#10b981", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "600" },
  section: { background: "white", borderRadius: "12px", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  sectionTitle: { fontSize: "18px", fontWeight: "600", marginBottom: "16px" },
  empty: { textAlign: "center", color: "#9ca3af", padding: "40px" },
  planCard: { border: "1px solid #e5e7eb", borderRadius: "10px", padding: "16px", marginBottom: "12px" },
  planHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" },
  planName: { fontSize: "16px", fontWeight: "600", margin: 0 },
  planCode: { fontSize: "12px", color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: "10px", marginRight: "8px" },
  productCount: { fontSize: "12px", color: "#4f46e5", background: "#ede9fe", padding: "2px 8px", borderRadius: "10px" },
  deleteBtn: { padding: "6px 12px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: "6px", cursor: "pointer" },
  plansInner: { background: "#f9fafb", borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" },
  planRow: { display: "flex", alignItems: "center", gap: "12px", fontSize: "14px" },
  intervalBadge: { background: "#dbeafe", color: "#1e40af", padding: "2px 8px", borderRadius: "10px", fontSize: "12px" },
  discountBadge: { background: "#d1fae5", color: "#065f46", padding: "2px 8px", borderRadius: "10px", fontSize: "12px" },
};

