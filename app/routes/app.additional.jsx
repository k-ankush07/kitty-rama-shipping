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


import React from 'react'

export default function Additional() {
  return (
    <div>app.additional</div>
  )
}


