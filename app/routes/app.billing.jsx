import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const res = await admin.graphql(`
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          createdAt
          currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price { amount currencyCode }
                  interval
                }
              }
            }
          }
        }
      }
    }
  `);

  const data = await res.json();
  return {
    subscriptions: data.data.currentAppInstallation.activeSubscriptions,
    shop: session.shop,
  };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan");

  const plans = {
    basic: { name: "Basic Plan", amount: "9.99", interval: "EVERY_30_DAYS", trialDays: 7 },
    pro: { name: "Pro Plan", amount: "29.99", interval: "EVERY_30_DAYS", trialDays: 14 },
    enterprise: { name: "Enterprise Plan", amount: "99.99", interval: "ANNUAL", trialDays: 30 },
  };

  const selected = plans[plan];
  if (!selected) return { error: "Invalid plan" };

  const res = await admin.graphql(`
    mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $trialDays: Int) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, trialDays: $trialDays, lineItems: $lineItems) {
        userErrors { field message }
        confirmationUrl
        appSubscription { id }
      }
    }
  `, {
    variables: {
      name: selected.name,
      returnUrl: `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`,
      trialDays: selected.trialDays,
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: selected.amount, currencyCode: "USD" },
            interval: selected.interval,
          }
        }
      }]
    }
  });

  const data = await res.json();
  if (data.data.appSubscriptionCreate.userErrors.length > 0) {
    return { error: data.data.appSubscriptionCreate.userErrors[0].message };
  }

  return redirect(data.data.appSubscriptionCreate.confirmationUrl);
}

export default function BillingPage() {
  const { subscriptions } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const billingPlans = [
    { key: "basic", name: "Basic", price: "$9.99/mo", trial: "7 days free", features: ["Up to 10 products", "Weekly & Monthly plans", "Basic analytics"], color: "#4f46e5" },
    { key: "pro", name: "Pro", price: "$29.99/mo", trial: "14 days free", features: ["Up to 100 products", "All intervals", "Advanced analytics", "Priority support"], color: "#7c3aed" },
    { key: "enterprise", name: "Enterprise", price: "$99.99/yr", trial: "30 days free", features: ["Unlimited products", "Custom intervals", "Full analytics", "Dedicated support", "API access"], color: "#db2777" },
  ];

  return (
    <s-page heading="Billing & Plans">
      {actionData?.error && <div style={styles.alert}>{actionData.error}</div>}

      {subscriptions.length > 0 && (
        <div style={styles.activeCard}>
          <h3 style={styles.activeTitle}>✅ Active Subscription</h3>
          {subscriptions.map((sub) => (
            <div key={sub.id}>
              <p><strong>Plan:</strong> {sub.name}</p>
              <p><strong>Status:</strong> {sub.status}</p>
              <p><strong>Renews:</strong> {new Date(sub.currentPeriodEnd).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}

      <h2 style={styles.plansTitle}>Choose a Plan</h2>
      <div style={styles.plansGrid}>
        {billingPlans.map((plan) => (
          <div key={plan.key} style={styles.planCard(plan.color)}>
            <div style={styles.planName(plan.color)}>{plan.name}</div>
            <div style={styles.planPrice}>{plan.price}</div>
            <div style={styles.planTrial}>🎉 {plan.trial}</div>
            <ul style={styles.featureList}>
              {plan.features.map((f) => <li key={f}>✓ {f}</li>)}
            </ul>
            <Form method="post">
              <input type="hidden" name="plan" value={plan.key} />
              <button style={styles.planBtn(plan.color)} type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Redirecting..." : "Subscribe Now"}
              </button>
            </Form>
          </div>
        ))}
      </div>
    </s-page>
  );
}

const styles = {
  alert: { padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", background: "#fee2e2", color: "#991b1b" },
  activeCard: { background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "12px", padding: "20px", marginBottom: "24px" },
  activeTitle: { color: "#15803d", marginBottom: "12px" },
  plansTitle: { fontSize: "22px", fontWeight: "700", marginBottom: "20px", textAlign: "center" },
  plansGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "20px" },
  planCard: (color) => ({ background: "white", borderRadius: "16px", padding: "24px", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", border: `2px solid ${color}20`, textAlign: "center" }),
  planName: (color) => ({ fontSize: "20px", fontWeight: "700", color, marginBottom: "8px" }),
  planPrice: { fontSize: "28px", fontWeight: "800", color: "#111827", marginBottom: "4px" },
  planTrial: { fontSize: "13px", color: "#6b7280", marginBottom: "20px" },
  featureList: { listStyle: "none", padding: 0, margin: "0 0 20px 0", textAlign: "left", fontSize: "14px", lineHeight: "2" },
  planBtn: (color) => ({ width: "100%", padding: "12px", background: color, color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "600", fontSize: "15px" }),
};

