// import { json } from "@remix-run/node";
// import { createStampsLabel } from "../utils/stamps";
// import { fulfillOrder } from "../utils/shopifyFulfill";
// import { authenticate, apiVersion } from "../shopify.server";
// import { useLoaderData } from "react-router-dom";

// export const loader = async ({ request }) => {
//   const { session } = await authenticate.admin(request);
//   const shop = session?.shop;
//   const accessToken = session?.accessToken;

//   let url = `https://${shop}/admin/api/${apiVersion}/orders.json`;
//   let orders = [];

//   while (url) {
//     const res = await fetch(url, {
//       headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
//     });
//     const data = await res.json();
//     orders.push(...data.orders);
//     const linkHeader = res.headers.get("link");
//     const nextPageMatch = linkHeader?.match(/<([^>]+)>; rel="next"/);
//     url = nextPageMatch ? nextPageMatch[1] : null;
//   }

//   const chewyOrders = [];
//   for (const order of orders) {
//     const tags = order.tags?.split(',').map(tag => tag.trim().toLowerCase()) || [];
//     if (tags.includes("chewy") && (order.fulfillment_status === null || order.fulfillment_status === "unfulfilled")) {
//       const { trackingNumber, labelURL } = await createStampsLabel(order);
//       await fulfillOrder(order, trackingNumber);
//       chewyOrders.push({ order, trackingNumber, labelURL });
//     }
//   }
//   return { orders: chewyOrders };
// };

// export default function Index() {
//   const { orders, error } = useLoaderData();

//   return (
//     <s-page heading="Shopify App Template">
//       {orders.map(({ order, trackingNumber, labelURL }) => (
//         <div
//           key={order.id}
//           style={{ border: "1px solid #ccc", margin: "10px 0", padding: "10px" }}
//         >
//           <h3>Order #{order.order_number} — {order.name}</h3>

//           <p><strong>Status:</strong> {order.financial_status} / {order.fulfillment_status || "Unfulfilled"}</p>
//           <p><strong>Created At:</strong> {order.created_at}</p>
//           <p><strong>Total:</strong> {order.current_total_price} {order.currency}</p>

//           <p><strong>Customer:</strong> {order.customer?.first_name || ""} {order.customer?.last_name || ""}</p>
//           <p><strong>Email:</strong> {order.email || order.contact_email}</p>
//           <p><strong>Phone:</strong> {order.phone || order.billing_address?.phone}</p>

//           <h4>Shipping Address:</h4>
//           {order.shipping_address ? (
//             <p>
//               {order.shipping_address.address1}, {order.shipping_address.city}, {order.shipping_address.province}, {order.shipping_address.country}, {order.shipping_address.zip}
//             </p>
//           ) : <p>N/A</p>}

//           <h4>Billing Address:</h4>
//           {order.billing_address ? (
//             <p>
//               {order.billing_address.address1}, {order.billing_address.city}, {order.billing_address.province}, {order.billing_address.country}, {order.billing_address.zip}
//             </p>
//           ) : <p>N/A</p>}

//           <h4>Line Items:</h4>
//           <ul>
//             {order.line_items.map(item => (
//               <li key={item.id}>
//                 {item.name} — {item.quantity} × {item.price} {order.currency}
//                 {item.variant_title && ` (Variant: ${item.variant_title})`}
//               </li>
//             ))}
//           </ul>

//           <p><strong>Tags:</strong> {order.tags || "None"}</p>
//           <p><strong>Payment Gateway:</strong> {order.payment_gateway_names.join(", ")}</p>
//           <p><strong>Tracking Number:</strong> {trackingNumber}</p>
//           <p>
//             <a href={labelURL} target="_blank" rel="noopener noreferrer">
//               Download Label
//             </a>
//           </p>

//           <p><a href={order.order_status_url} target="_blank" rel="noopener noreferrer">View in Shopify</a></p>
//         </div>
//       ))}
//     </s-page>
//   );
// } 



// import { useLoaderData, useNavigate } from "react-router";
// import { authenticate } from "../shopify.server";
// import { useState } from "react";

// export async function loader({ request }) {
//   const { admin } = await authenticate.admin(request);

//   // Fetch products
//   const productsRes = await admin.graphql(`
//     query {
//       products(first: 50) {
//         edges {
//           node {
//             id
//             title
//             featuredImage { url }
//             variants(first: 1) {
//               edges {
//                 node {
//                   id
//                   price
//                 }
//               }
//             }
//             sellingPlanGroups(first: 5) {
//               edges {
//                 node {
//                   id
//                   name
//                   sellingPlans(first: 5) {
//                     edges {
//                       node {
//                         id
//                         name
//                       }
//                     }
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   `);

//   // Fetch selling plan groups
//   const plansRes = await admin.graphql(`
//     query {
//       sellingPlanGroups(first: 20) {
//         edges {
//           node {
//             id
//             name
//             merchantCode
//             sellingPlans(first: 10) {
//               edges {
//                 node {
//                   id
//                   name
//                   billingPolicy {
//                     ... on SellingPlanRecurringBillingPolicy {
//                       interval
//                       intervalCount
//                     }
//                   }
//                   pricingPolicies {
//                     ... on SellingPlanFixedPricingPolicy {
//                       adjustmentType
//                       adjustmentValue {
//                         ... on SellingPlanPricingPolicyPercentageValue {
//                           percentage
//                         }
//                       }
//                     }
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   `);

//   const productsData = await productsRes.json();
//   const plansData = await plansRes.json();

//   return {
//     products: productsData.data.products.edges.map((e) => e.node),
//     sellingPlanGroups: plansData.data.sellingPlanGroups.edges.map((e) => e.node),
//   };
// }

// export default function Index() {
//   const { products, sellingPlanGroups } = useLoaderData();
//   const navigate = useNavigate();
//   const [selectedTab, setSelectedTab] = useState("dashboard");

//   const stats = {
//     totalProducts: products.length,
//     totalPlans: sellingPlanGroups.length,
//     subscribedProducts: products.filter(
//       (p) => p.sellingPlanGroups.edges.length > 0
//     ).length,
//   };

//   return (
//     <s-page heading="Subscription Manager">
//       {/* Stats Cards */}
//       <div style={styles.statsGrid}>
//         <div style={styles.statCard}>
//           <div style={styles.statNumber}>{stats.totalProducts}</div>
//           <div style={styles.statLabel}>Total Products</div>
//         </div>
//         <div style={{ ...styles.statCard, background: "linear-gradient(135deg, #667eea, #764ba2)" }}>
//           <div style={styles.statNumber}>{stats.totalPlans}</div>
//           <div style={styles.statLabel}>Selling Plans</div>
//         </div>
//         <div style={{ ...styles.statCard, background: "linear-gradient(135deg, #f093fb, #f5576c)" }}>
//           <div style={styles.statNumber}>{stats.subscribedProducts}</div>
//           <div style={styles.statLabel}>Subscribed Products</div>
//         </div>
//       </div>

//       {/* Quick Actions */}
//       <div style={styles.section}>
//         <h2 style={styles.sectionTitle}>Quick Actions</h2>
//         <div style={styles.actionGrid}>
//           <button style={styles.actionBtn} onClick={() => navigate("/app/products")}>
//             📦 Manage Products
//           </button>
//           <button style={styles.actionBtn} onClick={() => navigate("/app/plans")}>
//             📋 Manage Plans
//           </button>
//           <button style={styles.actionBtn} onClick={() => navigate("/app/subscribers")}>
//             👥 View Subscribers
//           </button>
//           <button style={styles.actionBtn} onClick={() => navigate("/app/billing")}>
//             💳 Billing Settings
//           </button>
//         </div>
//       </div>

//       {/* Recent Products with Plans */}
//       <div style={styles.section}>
//         <h2 style={styles.sectionTitle}>Products with Subscriptions</h2>
//         <div style={styles.table}>
//           <div style={styles.tableHeader}>
//             <span>Product</span>
//             <span>Price</span>
//             <span>Subscription Plans</span>
//             <span>Status</span>
//           </div>
//           {products.slice(0, 10).map((product) => (
//             <div key={product.id} style={styles.tableRow}>
//               <span style={styles.productName}>
//                 {product.featuredImage && (
//                   <img src={product.featuredImage.url} alt="" style={styles.thumb} />
//                 )}
//                 {product.title}
//               </span>
//               <span>₹{product.variants.edges[0]?.node.price || "N/A"}</span>
//               <span>
//                 {product.sellingPlanGroups.edges.length > 0 ? (
//                   <span style={styles.badge}>
//                     {product.sellingPlanGroups.edges.length} plan(s)
//                   </span>
//                 ) : (
//                   <span style={styles.badgeGray}>No plans</span>
//                 )}
//               </span>
//               <span>
//                 {product.sellingPlanGroups.edges.length > 0 ? (
//                   <span style={{ color: "#10b981" }}>✓ Active</span>
//                 ) : (
//                   <span style={{ color: "#6b7280" }}>— Inactive</span>
//                 )}
//               </span>
//             </div>
//           ))}
//         </div>
//       </div>
//     </s-page>
//   );
// }

// const styles = {
//   statsGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "24px" },
//   statCard: { background: "linear-gradient(135deg, #4f46e5, #7c3aed)", borderRadius: "12px", padding: "20px", color: "white", textAlign: "center" },
//   statNumber: { fontSize: "36px", fontWeight: "bold" },
//   statLabel: { fontSize: "14px", opacity: 0.8, marginTop: "4px" },
//   section: { background: "white", borderRadius: "12px", padding: "20px", marginBottom: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
//   sectionTitle: { fontSize: "18px", fontWeight: "600", marginBottom: "16px", color: "#111827" },
//   actionGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" },
//   actionBtn: { padding: "16px", background: "#f3f4f6", border: "none", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "500", transition: "background 0.2s" },
//   table: { width: "100%", borderCollapse: "collapse" },
//   tableHeader: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "12px", background: "#f9fafb", borderRadius: "8px", fontWeight: "600", color: "#374151", marginBottom: "8px" },
//   tableRow: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "12px", borderBottom: "1px solid #f3f4f6", alignItems: "center" },
//   productName: { display: "flex", alignItems: "center", gap: "8px" },
//   thumb: { width: "32px", height: "32px", borderRadius: "4px", objectFit: "cover" },
//   badge: { background: "#d1fae5", color: "#065f46", padding: "2px 8px", borderRadius: "12px", fontSize: "12px" },
//   badgeGray: { background: "#f3f4f6", color: "#6b7280", padding: "2px 8px", borderRadius: "12px", fontSize: "12px" },
// };

