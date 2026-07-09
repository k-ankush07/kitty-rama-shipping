import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return new Response(JSON.stringify({ error: "productId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const res = await admin.graphql(`
    query getFirstVariant($id: ID!) {
      product(id: $id) {
        variants(first: 1) {
          edges { node { id title } }
        }
      }
    }
  `, { variables: { id: productId } });

  const data = await res.json();
  const variant = data.data?.product?.variants?.edges?.[0]?.node;

  
  return new Response(JSON.stringify({ variantId: variant?.id || null, variantTitle: variant?.title || null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};