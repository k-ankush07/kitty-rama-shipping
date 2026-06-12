import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { useState } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const [productsRes, plansRes] = await Promise.all([
    admin.graphql(`
      query {
        products(first: 50) {
          edges {
            node {
              id
              title
              status
              featuredImage { url }
              variants(first: 1) { edges { node { id price } } }
              sellingPlanGroups(first: 5) {
                edges { node { id name } }
              }
            }
          }
        }
      }
    `),
    admin.graphql(`
      query {
        sellingPlanGroups(first: 20) {
          edges { node { id name } }
        }
      }
    `),
  ]);

  const productsData = await productsRes.json();
  const plansData = await plansRes.json();

  return {
    products: productsData.data.products.edges.map((e) => e.node),
    sellingPlanGroups: plansData.data.sellingPlanGroups.edges.map((e) => e.node),
  };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "assign") {
    const productId = formData.get("productId");
    const planGroupId = formData.get("planGroupId");

    const res = await admin.graphql(`
      mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
          sellingPlanGroup { id name }
          userErrors { field message }
        }
      }
    `, { variables: { id: planGroupId, productIds: [productId] } });

    const data = await res.json();
    console.log("response:", JSON.stringify(data, null, 2));
    if (data.data.sellingPlanGroupAddProducts.userErrors.length > 0) {
      return { error: data.data.sellingPlanGroupAddProducts.userErrors[0].message };
    }
    return { success: "Product assigned to plan!" };
  }

  if (intent === "remove") {
    const productId = formData.get("productId");
    const planGroupId = formData.get("planGroupId");

    await admin.graphql(`
      mutation sellingPlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
          removedProductIds
          userErrors { field message }
        }
      }
    `, { variables: { id: planGroupId, productIds: [productId] } });

    return { success: "Product removed from plan!" };
  }

  return {};
}

export default function ProductsPage() {
  const { products, sellingPlanGroups } = useLoaderData();
  const actionData = useActionData();
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);

  const filtered = products.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <s-page heading="Products & Subscriptions">
      {actionData?.success && <div style={styles.alert("success")}>{actionData.success}</div>}
      {actionData?.error && <div style={styles.alert("error")}>{actionData.error}</div>}

      <div style={{ marginBottom: "20px" }}>
        <input
          style={styles.searchInput}
          placeholder="🔍 Search products..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div style={styles.layout}>
        <div style={styles.productsList}>
          <h3 style={styles.listTitle}>Products ({filtered.length})</h3>
          {filtered.map((product) => (
            <div
              key={product.id}
              style={{ ...styles.productItem, ...(selectedProduct?.id === product.id ? styles.productItemActive : {}) }}
              onClick={() => setSelectedProduct(product)}
            >
              {product.featuredImage && (
                <img src={product.featuredImage.url} alt="" style={styles.thumb} />
              )}
              <div style={{ flex: 1 }}>
                <div style={styles.productTitle}>{product.title}</div>
                <div style={styles.productPrice}>₹{product.variants.edges[0]?.node.price}</div>
              </div>
              {product.sellingPlanGroups.edges.length > 0
                ? <span style={styles.activeBadge}>✓</span>
                : <span style={styles.inactiveBadge}>—</span>}
            </div>
          ))}
        </div>

        <div style={styles.detailPanel}>
          {selectedProduct ? (
            <>
              <h3 style={styles.listTitle}>Manage: {selectedProduct.title}</h3>
              {selectedProduct.sellingPlanGroups.edges.length > 0 && (
                <div style={styles.currentPlans}>
                  <h4 style={styles.subTitle}>Current Plans</h4>
                  {selectedProduct.sellingPlanGroups.edges.map(({ node }) => (
                    <div key={node.id} style={styles.currentPlanRow}>
                      <span>📋 {node.name}</span>
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="productId" value={selectedProduct.id} />
                        <input type="hidden" name="planGroupId" value={node.id} />
                        <button style={styles.removeBtn} type="submit">Remove</button>
                      </Form>
                    </div>
                  ))}
                </div>
              )}
              <h4 style={styles.subTitle}>Assign a Plan</h4>
              {sellingPlanGroups.length === 0 ? (
                <p style={{ color: "#6b7280" }}>No plans available. Create one first.</p>
              ) : (
                sellingPlanGroups.map((plan) => {
                  const alreadyAssigned = selectedProduct.sellingPlanGroups.edges.some(({ node }) => node.id === plan.id);
                  return (
                    <div key={plan.id} style={styles.assignRow}>
                      <span>📅 {plan.name}</span>
                      {alreadyAssigned ? (
                        <span style={{ color: "#10b981", fontSize: "13px" }}>✓ Assigned</span>
                      ) : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="assign" />
                          <input type="hidden" name="productId" value={selectedProduct.id} />
                          <input type="hidden" name="planGroupId" value={plan.id} />
                          <button style={styles.assignBtn} type="submit">+ Assign</button>
                        </Form>
                      )}
                    </div>
                  );
                })
              )}
            </>
          ) : (
            <div style={styles.emptyDetail}>👈 Select a product to manage its subscription plans</div>
          )}
        </div>
      </div>
    </s-page>
  );
}

const styles = {
  alert: (type) => ({ padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", background: type === "success" ? "#d1fae5" : "#fee2e2", color: type === "success" ? "#065f46" : "#991b1b", fontWeight: "500" }),
  searchInput: { width: "100%", padding: "12px 16px", border: "1px solid #d1d5db", borderRadius: "8px", fontSize: "14px", boxSizing: "border-box" },
  layout: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" },
  productsList: { background: "white", borderRadius: "12px", padding: "16px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)", maxHeight: "600px", overflowY: "auto" },
  listTitle: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" },
  productItem: { display: "flex", alignItems: "center", gap: "10px", padding: "10px", borderRadius: "8px", cursor: "pointer", marginBottom: "6px", border: "1px solid transparent" },
  productItemActive: { background: "#ede9fe", border: "1px solid #7c3aed" },
  thumb: { width: "40px", height: "40px", borderRadius: "6px", objectFit: "cover" },
  productTitle: { fontWeight: "500", fontSize: "14px" },
  productPrice: { fontSize: "12px", color: "#6b7280" },
  activeBadge: { background: "#d1fae5", color: "#065f46", padding: "2px 8px", borderRadius: "10px", fontSize: "12px" },
  inactiveBadge: { background: "#f3f4f6", color: "#9ca3af", padding: "2px 8px", borderRadius: "10px", fontSize: "12px" },
  detailPanel: { background: "white", borderRadius: "12px", padding: "16px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  currentPlans: { background: "#f0fdf4", borderRadius: "8px", padding: "12px", marginBottom: "16px" },
  subTitle: { fontSize: "14px", fontWeight: "600", marginBottom: "10px", color: "#374151" },
  currentPlanRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #d1fae5" },
  removeBtn: { padding: "4px 10px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px" },
  assignRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px", borderBottom: "1px solid #f3f4f6" },
  assignBtn: { padding: "6px 12px", background: "#4f46e5", color: "white", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px" },
  emptyDetail: { textAlign: "center", color: "#9ca3af", padding: "60px 20px", fontSize: "15px" },
};

