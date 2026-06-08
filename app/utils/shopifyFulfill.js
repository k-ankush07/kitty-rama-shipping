import fetch from "node-fetch";

export async function fulfillOrder(order, trackingNumber) {
  console.log(`STARTING SHOPIFY FULFILLMENT for Order ${order.order_number}`);

  if (!order || !trackingNumber)
    throw new Error("Order or tracking number missing!");

  const shop = process.env.SHOPIFY_SHOP;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !accessToken) throw new Error("Shop or access token missing.");

  const fulfillmentOrdersRes = await fetch(
    `https://${shop}/admin/api/2025-07/orders/${order.id}/fulfillment_orders.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  const fulfillmentOrdersData = await fulfillmentOrdersRes.json();
  const fulfillmentOrder = fulfillmentOrdersData.fulfillment_orders?.[0];
  if (!fulfillmentOrder)
    throw new Error("No fulfillment orders found for this order");

  const fulfillmentOrderGID = `gid://shopify/FulfillmentOrder/${fulfillmentOrder.id}`;

  const gqlUrl = `https://${shop}/admin/api/2025-07/graphql.json`;
  const gqlMutation = `
    mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo {
            number
            company
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const gqlVariables = {
    fulfillment: {
      notifyCustomer: true,
      trackingInfo: {
        number: trackingNumber,
        company: "USPS",
      },
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${fulfillmentOrder.id}`,
          fulfillmentOrderLineItems: fulfillmentOrder.line_items
            .filter((item) => item.fulfillable_quantity > 0)
            .map((item) => ({
              id: `gid://shopify/FulfillmentOrderLineItem/${item.id}`,
              quantity: item.fulfillable_quantity,
            })),
        },
      ],
    },
  };

  console.log(
    "GraphQL Fulfillment Payload →",
    JSON.stringify(gqlVariables, null, 2),
  );

  const gqlRes = await fetch(gqlUrl, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: gqlMutation,
      variables: gqlVariables,
    }),
  });

  const gqlData = await gqlRes.json();

  if (gqlData.errors) {
    console.error("GraphQL Errors:", gqlData.errors);
    throw new Error("Failed to create fulfillment via GraphQL");
  }

  if (gqlData.data.fulfillmentCreateV2.userErrors.length > 0) {
    console.error("User Errors:", gqlData.data.fulfillmentCreateV2.userErrors);
    throw new Error("Shopify reported user errors during fulfillment creation");
  }

  const createdFulfillment = gqlData.data.fulfillmentCreateV2.fulfillment;
  console.log("✅ Fulfillment Created with Tracking:", createdFulfillment);

  return createdFulfillment;
}
