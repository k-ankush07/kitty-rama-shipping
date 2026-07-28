// app/routes/auth.$.jsx

import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { session, redirectUrl } = await authenticate.admin(request);

  if (redirectUrl) {
    return redirect(redirectUrl);
  }

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const host = url.searchParams.get("host") || "";

  return redirect(`/app?host=${encodeURIComponent(host)}`);
}