import { redirect } from "react-router";
import { Form, useNavigation, useSearchParams } from "react-router";
import { setOnboardingCompleted, getShopRecord } from "../models/shop.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    throw new Response("Missing shop", { status: 400 });
  }

  const shopRecord = await getShopRecord(shop);
  if (shopRecord && shopRecord.onboardingCompleted) {
    return redirect(`/app?shop=${encodeURIComponent(shop)}`);
  }

  return { ok: true };
}

export async function action({ request }) {
  const formData = await request.formData();
  const shop = formData.get("shop");
  const apiKey = formData.get("apiKey");

  if (!shop) {
    return { error: "Missing shop" };
  }

  await setOnboardingCompleted(shop.toString());
  return redirect(`/app?shop=${encodeURIComponent(shop.toString())}`);
}

export default function OnboardingRoute() {
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const shop = searchParams.get("shop") || "";

  if (!shop) {
    return <div>Missing shop in URL.</div>;
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>Welcome, {shop}</h1>
      <p>Let's connect your account and finish setup.</p>

      <Form method="post">
        <input type="hidden" name="shop" value={shop} />
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8 }}>
            External service API key:
          </label>
          <input name="apiKey" style={{ width: "100%", padding: 8 }} />
        </div>
        <button type="submit" disabled={isSubmitting} style={{ padding: "8px 16px" }}>
          {isSubmitting ? "Saving..." : "Complete onboarding"}
        </button>
      </Form>
    </div>
  );
}