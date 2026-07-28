// app/routes/auth.callback.jsx
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { session, redirectUrl } = await authenticate.admin(request);

  // 1) If Shopify still needs to complete OAuth, go to that URL
  if (redirectUrl) {
    return redirect(redirectUrl);
  }

  // 2) If no session after the auth flow, something went wrong
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  // 3) If we are authenticated, redirect to your app
  //    Include host from the current request so App Bridge can use it
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";

  // If you want to use shop from session you can:
  // const shop = session.shop;
  // return redirect(`/app?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}`);

  // Recommended: let /app loader read shop from session;
  // only pass host in URL
  return redirect(`/app?host=${encodeURIComponent(host)}`);
}