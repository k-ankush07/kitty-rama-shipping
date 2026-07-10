// app/routes/app.customer-portal.jsx

import { useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const res = await admin.graphql(`
    query GetCustomerAccountShareLinkData($pageCount: Int = 50) {
      shop {
        customerAccountsV2 {
          url
        }
      }
      customerAccountPages(first: $pageCount) {
        nodes {
          __typename
          handle
          title
          ... on CustomerAccountAppExtensionPage {
            appExtensionUuid
          }
        }
      }
    }
  `);

  const { data } = await res.json();
  const baseUrl = data.shop.customerAccountsV2.url;
  const targetUuid = process.env.CUSTOMER_ACCOUNT_EXTENSION_UUID;

  const myPage = data.customerAccountPages.nodes.find(
    (n) =>
      n.__typename === "CustomerAccountAppExtensionPage" &&
      n.appExtensionUuid === targetUuid
  );

  const portalUrl = myPage ? `${baseUrl}/pages/${myPage.handle}` : baseUrl;

  return {
    portalUrl,
    shopDomain: session.shop,
    foundExtension: Boolean(myPage),
  };
};

export default function CustomerPortal() {
  const { portalUrl, shopDomain, foundExtension } = useLoaderData();
  const [copied, setCopied] = useState(false);
  const [showBanner, setShowBanner] = useState(true);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <s-page heading="Customer portal">
      <s-section>
        {showBanner && (
          <s-banner tone="info" onDismiss={() => setShowBanner(false)}>
            <s-link
              href="https://help.shopify.com/en/manual/customers/customer-accounts"
              target="_blank"
            >
              Watch: How to let customers manage their own subscriptions
            </s-link>
          </s-banner>
        )}

        {!foundExtension && (
          <s-banner tone="warning">
            Extension page abhi merchant ke checkout editor mein add nahi
            hua hai, isliye fallback URL dikh raha hai. Neeche Step 3 follow
            karo.
          </s-banner>
        )}

        <s-stack direction="block" gap="loose" style={{ marginTop: "16px" }}>
          <div>
            <s-text fontWeight="bold">Self-service</s-text>
            <s-text
              tone="subdued"
              style={{ display: "block", marginTop: "4px" }}
            >
              To let customers manage subscriptions, enable it in{" "}
              <s-link
                href={`https://${shopDomain}/admin/settings/checkout`}
                target="_blank"
              >
                Checkout settings
              </s-link>
              .
            </s-text>
          </div>

          <div>
            <s-text fontWeight="bold">Customer portal URL</s-text>
            <s-text
              tone="subdued"
              style={{
                display: "block",
                marginTop: "4px",
                marginBottom: "10px",
              }}
            >
              Add the customer portal URL anywhere you'd like to give customers
              an entry point to the subscriptions management page.
            </s-text>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "1px solid #d1d5db",
                borderRadius: "8px",
                padding: "10px 14px",
                background: "#f9fafb",
              }}
            >
              <s-text
                style={{
                  fontFamily: "monospace",
                  fontSize: "13px",
                }}
              >
                {portalUrl}
              </s-text>

              <s-stack direction="inline" gap="tight">
                <s-button onClick={copyUrl}>
                  {copied ? "Copied!" : "Copy"}
                </s-button>

                <s-button onClick={() => window.open(portalUrl, "_blank")}>
                  Open
                </s-button>
              </s-stack>
            </div>
          </div>
        </s-stack>
      </s-section>
    </s-page>
  );
}