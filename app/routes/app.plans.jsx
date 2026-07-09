import { useLoaderData, useActionData, Form, useNavigation, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useRef, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

function metaKeyForGroup(groupId) {
  const numericId = groupId.split("/").pop();
  return `extra_settings_${numericId}`;
}
const EXTRA_SETTINGS_NAMESPACE = "subscription_app";
const AUDIT_LOG_KEY = "audit_log";

// ─── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(`
    query {
      sellingPlanGroups(first: 20) {
        edges {
          node {
            id
            name
            merchantCode
            products(first: 5) {
              edges { node { id title featuredImage { url } } }
              pageInfo { hasNextPage }
            }
            sellingPlans(first: 10) {
              edges {
                node {
                  id
                  name
                  billingPolicy {
                    ... on SellingPlanRecurringBillingPolicy {
                      interval
                      intervalCount
                      minCycles
                      maxCycles
                    }
                    ... on SellingPlanFixedBillingPolicy {
                      remainingBalanceChargeTrigger
                      checkoutCharge {
                        type
                        value {
                          ... on SellingPlanCheckoutChargePercentageValue {
                            percentage
                          }
                        }
                      }
                    }
                  }
                  pricingPolicies {
                    ... on SellingPlanFixedPricingPolicy {
                      adjustmentType
                      adjustmentValue {
                        ... on SellingPlanPricingPolicyPercentageValue {
                          percentage
                        }
                      }
                    }
                    ... on SellingPlanRecurringPricingPolicy {
                      adjustmentType
                      afterCycle
                      adjustmentValue {
                        ... on SellingPlanPricingPolicyPercentageValue {
                          percentage
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const data = await res.json();
  const sellingPlanGroups = data.data.sellingPlanGroups.edges.map((e) => e.node);

  let metafieldsByKey = new Map();
  let auditLog = [];
  try {
    const metaRes = await admin.graphql(`
      query {
        shop {
          metafields(namespace: "${EXTRA_SETTINGS_NAMESPACE}", first: 250) {
            edges { node { key value } }
          }
        }
      }
    `);
    const metaData = await metaRes.json();
    const edges = metaData.data?.shop?.metafields?.edges || [];
    metafieldsByKey = new Map(edges.map(({ node }) => [node.key, node.value]));

    const rawAuditLog = metafieldsByKey.get(AUDIT_LOG_KEY);
    if (rawAuditLog) {
      try {
        auditLog = JSON.parse(rawAuditLog);
      } catch (_) {
        auditLog = [];
      }
    }
  } catch (_) {
    // If this fails for any reason, just fall back to no extra settings
    // rather than breaking the whole page.
  }

  const groupsWithMeta = sellingPlanGroups.map((group) => {
    const raw = metafieldsByKey.get(metaKeyForGroup(group.id));
    let extraSettings = null;
    if (raw) {
      try {
        extraSettings = JSON.parse(raw);
      } catch (_) {
        extraSettings = null;
      }
    }
    return { ...group, extraSettings };
  });

  return { sellingPlanGroups: groupsWithMeta, auditLog: [...auditLog].reverse() };
}

// ─── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Create plan ──
  if (intent === "create") {
    const name = formData.get("name");
    const interval = formData.get("interval");
    const intervalCount = parseInt(formData.get("intervalCount"));
    const discount = parseFloat(formData.get("discount") || "0");
    const billingType = formData.get("billingType") || "DEFAULT";
    const minCycles = parseInt(formData.get("minCycles") || "0");
    const maxCycles = parseInt(formData.get("maxCycles") || "0");

    // Tiered discount
    const tieredDiscount = formData.get("tieredDiscount") === "true";
    const tieredDiscountValue = parseFloat(formData.get("tieredDiscountValue") || "0");
    const tieredDiscountAfter = parseInt(formData.get("tieredDiscountAfter") || "1");
    const tieredDiscountType = formData.get("tieredDiscountType") || "PERCENTAGE";

    // Shipping discount (saved to metafield)
    const shippingDiscount = formData.get("shippingDiscount") === "true";
    const shippingDiscountValue = parseFloat(formData.get("shippingDiscountValue") || "0");
    const shippingDiscountAfter = parseInt(formData.get("shippingDiscountAfter") || "0");
    const shippingDiscountType = formData.get("shippingDiscountType") || "PRICE";

    // Quantity settings (saved to metafield)
    const quantityChange = formData.get("quantityChange") === "true";
    const quantityChangeValue = parseInt(formData.get("quantityChangeValue") || "1");
    const quantityChangeAfter = parseInt(formData.get("quantityChangeAfter") || "1");
    const setMinQuantity = formData.get("setMinQuantity") === "true";
    const minQuantity = parseInt(formData.get("minQuantity") || "1");

    // Automatic actions (saved to metafield)
    const allowAutomaticActions = formData.get("allowAutomaticActions") === "true";
    let automaticActions = [];
    try { automaticActions = JSON.parse(formData.get("automaticActions") || "[]"); } catch (_) { }

    // Customer product changes (saved to metafield)
    const allowSwaps = formData.get("allowSwaps") === "on" || formData.get("allowSwaps") === "true";
    const allowVariantChanges = formData.get("allowVariantChanges") === "on" || formData.get("allowVariantChanges") === "true";
    const allowQuantityChanges = formData.get("allowQuantityChanges") === "on" || formData.get("allowQuantityChanges") === "true";
    const keepDiscounts = formData.get("keepDiscounts") === "on" || formData.get("keepDiscounts") === "true";

    let selectedProductIds = [];
    try { selectedProductIds = JSON.parse(formData.get("selectedProductIds") || "[]"); } catch (_) { }

    // ── Build pricing policies ──
    const pricingPolicies = [];

    if (discount > 0) {
      pricingPolicies.push({
        fixed: {
          adjustmentType: "PERCENTAGE",
          adjustmentValue: { percentage: discount },
        },
      });
    }

    // Tiered discount uses recurring with afterCycle
    if (tieredDiscount && tieredDiscountValue > 0) {
      pricingPolicies.push({
        recurring: {
          adjustmentType: tieredDiscountType,
          adjustmentValue:
            tieredDiscountType === "PERCENTAGE"
              ? { percentage: tieredDiscountValue }
              : { fixedValue: tieredDiscountValue },
          afterCycle: tieredDiscountAfter,
        },
      });
    }

    const isPrePaid = billingType === "PRE_PAID";

    const billingPolicy = isPrePaid
      ? { fixed: { checkoutCharge: { type: "PERCENTAGE", value: { percentage: 100 } }, remainingBalanceChargeTrigger: "NO_REMAINING_BALANCE" } }
      : { recurring: { interval, intervalCount, ...(minCycles > 0 && { minCycles }), ...(maxCycles > 0 && { maxCycles }) } };

    const sellingPlanInput = {
      name: `Every ${intervalCount} ${interval.toLowerCase()}`,
      category: "SUBSCRIPTION",
      options: [`${intervalCount} ${interval}`],
      billingPolicy,
      deliveryPolicy: isPrePaid
        ? { fixed: { fulfillmentTrigger: "ASAP" } }
        : { recurring: { interval, intervalCount } },
      ...(pricingPolicies.length > 0 && { pricingPolicies }),
    };

    const query = `
      mutation CreateSellingPlanGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
        sellingPlanGroupCreate(input: $input, resources: $resources) {
          sellingPlanGroup { id name }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      input: {
        name,
        merchantCode: name.toLowerCase().replace(/\s+/g, "-"),
        options: ["Delivery every"],
        sellingPlansToCreate: [sellingPlanInput],
      },
      resources: {},
    };

    const res = await fetch(`https://${session.shop}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query, variables }),
    });

    const data = await res.json();
    if (data.errors) return { error: data.errors[0].message };
    if (data.data.sellingPlanGroupCreate.userErrors.length > 0) {
      return { error: data.data.sellingPlanGroupCreate.userErrors[0].message };
    }

    const newGroupId = data.data.sellingPlanGroupCreate.sellingPlanGroup.id;

    // ── Assign products ──
    if (selectedProductIds.length > 0) {
      await fetch(`https://${session.shop}/admin/api/2025-10/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
        body: JSON.stringify({
          query: `mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
            sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
              sellingPlanGroup { id }
              userErrors { field message }
            }
          }`,
          variables: { id: newGroupId, productIds: selectedProductIds },
        }),
      });
    }

    // ── Save extra settings to a Shop metafield ──
    // (SellingPlanGroup can't own metafields — see metaKeyForGroup() above)
    const extraSettings = {
      shippingDiscount: shippingDiscount
        ? { enabled: true, value: shippingDiscountValue, after: shippingDiscountAfter, type: shippingDiscountType }
        : { enabled: false },
      quantityChange: quantityChange
        ? { enabled: true, value: quantityChangeValue, after: quantityChangeAfter }
        : { enabled: false },
      minQuantity: setMinQuantity
        ? { enabled: true, value: minQuantity }
        : { enabled: false },
      automaticActions: allowAutomaticActions ? automaticActions : [],
      customerChanges: { allowSwaps, allowVariantChanges, allowQuantityChanges, keepDiscounts },
    };

    let metafieldWarning = null;
    try {
      const shopRes = await admin.graphql(`{ shop { id } }`);
      const shopData = await shopRes.json();
      const shopId = shopData.data?.shop?.id;

      const metaRes = await admin.graphql(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id key value }
            userErrors { field message }
          }
        }
      `, {
        variables: {
          metafields: [{
            ownerId: shopId,
            namespace: EXTRA_SETTINGS_NAMESPACE,
            key: metaKeyForGroup(newGroupId),
            type: "json",
            value: JSON.stringify(extraSettings),
          }],
        },
      });

      const metaData = await metaRes.json();
      const userErrors = metaData.data?.metafieldsSet?.userErrors;
      if (userErrors?.length > 0) {
        metafieldWarning = userErrors[0].message;
      }
    } catch (err) {
      // The plan itself was already created successfully — don't fail the
      // whole request just because the extra-settings metafield didn't save.
      metafieldWarning = "extra settings could not be saved";
    }

    return {
      success: `Plan created successfully!${selectedProductIds.length > 0 ? ` ${selectedProductIds.length} product(s) assigned.` : ""}${metafieldWarning ? ` (Note: ${metafieldWarning}.)` : ""}`,
      created: true,
    };
  }

  // ── Assign product to existing plan ──
  if (intent === "assignProduct") {
    const planGroupId = formData.get("planGroupId");
    let productIds = [];
    try { productIds = JSON.parse(formData.get("productIds") || "[]"); } catch (_) { }
    if (productIds.length === 0) return { error: "No products selected." };

    const res = await admin.graphql(`
      mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
          sellingPlanGroup { id name }
          userErrors { field message }
        }
      }
    `, { variables: { id: planGroupId, productIds } });

    const data = await res.json();
    if (data.data.sellingPlanGroupAddProducts.userErrors.length > 0) {
      return { error: data.data.sellingPlanGroupAddProducts.userErrors[0].message };
    }
    return { success: `${productIds.length} product(s) assigned to plan!` };
  }

  // ── Delete plan ──
  if (intent === "delete") {
    const planGroupId = formData.get("planGroupId");
    await admin.graphql(`
      mutation sellingPlanGroupDelete($id: ID!) {
        sellingPlanGroupDelete(id: $id) {
          deletedSellingPlanGroupId
          userErrors { field message }
        }
      }
    `, { variables: { id: planGroupId } });

    // Best-effort cleanup of the Shop metafield holding this group's extra
    // settings, so deleted plans don't leave orphaned metafields behind.
    try {
      const shopRes = await admin.graphql(`{ shop { id } }`);
      const shopData = await shopRes.json();
      const shopId = shopData.data?.shop?.id;
      if (shopId) {
        await admin.graphql(`
          mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
              deletedMetafields { key ownerId }
              userErrors { field message }
            }
          }
        `, {
          variables: {
            metafields: [{
              ownerId: shopId,
              namespace: EXTRA_SETTINGS_NAMESPACE,
              key: metaKeyForGroup(planGroupId),
            }],
          },
        });
      }
    } catch (_) {
      // Non-critical — the plan group itself was already deleted.
    }

    return { success: "Plan deleted!" };
  }

  return {};
}

// ─── Action type definitions ───────────────────────────────────────────────────

const ACTION_MENU = [
  {
    group: "Swap to different product(s)",
    items: [
      { type: "PRODUCT_SWAP", label: "Add product swap" },
      { type: "VARIANT_SWAP", label: "Add variant swap" },
    ],
  },
  {
    group: "Add product to subscription",
    items: [{ type: "ADD_PRODUCT", label: "Add product" }],
  },
  {
    group: "Remove from subscription",
    items: [
      { type: "REMOVE_PRODUCT", label: "Remove product" },
      { type: "REMOVE_VARIANT", label: "Remove specific variant" },
    ],
  },
];

const ACTION_LABELS = {
  PRODUCT_SWAP: "Product swap",
  VARIANT_SWAP: "Variant swap",
  ADD_PRODUCT: "Add product",
  REMOVE_PRODUCT: "Remove product",
  REMOVE_VARIANT: "Remove specific variant",
};

const ACTION_DESCRIPTIONS = {
  PRODUCT_SWAP: "Swap to a different product after a set number of orders",
  VARIANT_SWAP: "Swap to a different variant after a set number of orders",
  ADD_PRODUCT: "Add a product to the subscription after a set number of orders",
  REMOVE_PRODUCT: "Remove a product from the subscription after a set number of orders",
  REMOVE_VARIANT: "Remove a specific variant from the subscription after a set number of orders",
};

const ACTION_ICONS = {
  PRODUCT_SWAP: "🔄",
  VARIANT_SWAP: "↔️",
  ADD_PRODUCT: "➕",
  REMOVE_PRODUCT: "🗑",
  REMOVE_VARIANT: "✂️",
};

const NEEDS_VARIANT_PICKER = ["PRODUCT_SWAP", "VARIANT_SWAP", "REMOVE_VARIANT"];

// ─── Sub-components ────────────────────────────────────────────────────────────

function SectionCard({ title, children }) {
  return (
    <div style={s.card}>
      {title && <h3 style={s.cardTitle}>{title}</h3>}
      {children}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
      {hint && <p style={s.hint}>{hint}</p>}
    </div>
  );
}

function Toggle({ id, name, label, description, checked, onChange }) {
  return (
    <label style={s.toggleRow} htmlFor={id}>
      <input
        id={id} type="checkbox" name={name} defaultChecked={checked} onChange={onChange}
        style={{ accentColor: "#4f46e5", width: 16, height: 16, flexShrink: 0, marginTop: 2 }}
      />
      <div>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
        {description && <div style={s.hint}>{description}</div>}
      </div>
    </label>
  );
}

function SelectField({ label, name, options, defaultValue }) {
  return (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue} style={s.input}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function NumberSelect({ label, name, min, max, disabledLabel, defaultValue }) {
  const options = [];
  if (disabledLabel) options.push(<option key={0} value={0}>{disabledLabel}</option>);
  for (let i = min; i <= max; i++) options.push(<option key={i} value={i}>{i}</option>);
  return (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue ?? 0} style={s.input}>{options}</select>
    </Field>
  );
}

// ─── Product Picker Button ─────────────────────────────────────────────────────

function ProductPickerButton({ selectedProducts, onSelect, multiple = true, label = "Select products" }) {
  const shopify = useAppBridge();

  const openPicker = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple,
      selectionIds: selectedProducts.map((p) => ({ id: p.id })),
    });
    if (!selected) return;
    onSelect(selected.map((p) => ({
      id: p.id,
      title: p.title,
      image: p.images?.[0]?.originalSrc || p.featuredImage?.originalSrc,
    })));
  };

  return (
    <div>
      {selectedProducts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {selectedProducts.map((p) => (
            <div key={p.id} style={s.selectedProduct}>
              {p.image && (
                <img src={p.image} alt="" style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 5, border: "1px solid #e5e7eb" }} />
              )}
              <div style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "#111827" }}>{p.title}</div>
              <button
                type="button"
                style={{ ...s.changeProductBtn, color: "#991b1b" }}
                onClick={() => onSelect(selectedProducts.filter((x) => x.id !== p.id))}
              >✕</button>
            </div>
          ))}
          <button type="button" style={s.selectProductBtn} onClick={openPicker}>+ Add more products</button>
        </div>
      ) : (
        <button type="button" style={s.selectProductBtn} onClick={openPicker}>🔍 {label}</button>
      )}
    </div>
  );
}

// ─── Add Action Dropdown ───────────────────────────────────────────────────────

function AddActionDropdown({ onAdd }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div style={{ position: "relative", display: "inline-block" }} ref={ref}>
      <button type="button" style={s.addActionBtn} onClick={() => setOpen((v) => !v)}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>＋</span>
        <span>Add action</span>
        <span style={{ fontSize: 10, marginLeft: 2 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={s.dropdown}>
          {ACTION_MENU.map((group) => (
            <div key={group.group}>
              <div style={s.dropdownGroup}>{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.type} type="button" style={s.dropdownItem}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  onClick={() => { onAdd(item.type); setOpen(false); }}
                >
                  {ACTION_ICONS[item.type]} {item.label}
                </button>
              ))}
              <div style={s.dropdownDivider} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Action Row ───────────────────────────────────────────────────────────────

function ActionRow({ action, index, onChange, onRemove }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const needsVariant = NEEDS_VARIANT_PICKER.includes(action.type);
  const hasProduct = action.productTitle || action.variantTitle;

  const openPicker = async () => {
    const selected = await shopify.resourcePicker({
      type: needsVariant ? "variant" : "product",
      multiple: false,
      selectionIds: action.productId ? [{ id: action.productId }] : [],
    });
    if (!selected || selected.length === 0) return;

    if (needsVariant) {
      const variant = selected[0];
      onChange(index, {
        ...action,
        productId: variant.product?.id,
        productTitle: variant.product?.title,
        variantId: variant.id,
        variantTitle: variant.displayName || variant.title,
        variantImage: variant.image?.originalSrc || variant.product?.featuredImage?.originalSrc,
      });
    } else {
      const product = selected[0];
      const res = await fetch(`/app/api/product-variant?productId=${encodeURIComponent(product.id)}`);
      const data = await res.json();

      onChange(index, {
        ...action,
        productId: product.id,
        productTitle: product.title,
        productImage: product.images?.[0]?.originalSrc,
        variantId: data.variantId,
        variantTitle: data.variantTitle !== "Default Title" ? data.variantTitle : undefined,
        variantImage: undefined,
      });
    }
  };

  return (
    <div style={s.actionRow}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, width: "100%" }}>
        <div style={s.actionRowLeft}>
          <span style={s.actionIcon}>{ACTION_ICONS[action.type]}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{ACTION_LABELS[action.type]}</div>
            <div style={s.hint}>{ACTION_DESCRIPTIONS[action.type]}</div>

            {hasProduct ? (
              <div style={s.selectedProduct}>
                {(action.productImage || action.variantImage) && (
                  <img
                    src={action.variantImage || action.productImage} alt=""
                    style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }}
                  />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#111827" }}>{action.productTitle}</div>
                  {action.variantTitle && <div style={{ fontSize: 11, color: "#6b7280" }}>{action.variantTitle}</div>}
                </div>
                <button type="button" style={s.changeProductBtn} onClick={openPicker}>Change</button>
              </div>
            ) : (
              <button type="button" style={{ ...s.selectProductBtn, marginTop: 8 }} onClick={openPicker}>
                {needsVariant ? "🔍 Select variant" : "🔍 Select product"}
              </button>
            )}

            <div style={{ marginTop: 10 }}>
              <label style={{ ...s.label, display: "block", marginBottom: 4 }}>After # of orders</label>
              <input
                type="number" min={1} value={action.afterCycle || 1}
                style={{ ...s.input, width: 100 }}
                onChange={(e) => onChange(index, { ...action, afterCycle: parseInt(e.target.value) || 1 })}
              />
            </div>
          </div>
        </div>
        <button type="button" style={s.removeActionBtn} onClick={() => onRemove(index)} title="Remove">✕</button>
      </div>
    </div>
  );
}

// ─── Assign Products Panel ─────────────────────────────────────────────────────

function AssignProductsPanel({ group }) {
  const [open, setOpen] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" style={s.assignProductsBtn} onClick={() => setOpen((v) => !v)}>
        {open ? "▲ Hide" : "📦 Assign Products"}
      </button>

      {open && (
        <div style={{ marginTop: 10, padding: 14, background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          {group.products.edges.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Currently assigned
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {group.products.edges.map(({ node: p }) => (
                  <div key={p.id} style={s.assignedProductChip}>
                    {p.featuredImage && (
                      <img src={p.featuredImage.url} alt="" style={{ width: 20, height: 20, borderRadius: 3, objectFit: "cover" }} />
                    )}
                    <span style={{ fontSize: 12 }}>{p.title}</span>
                  </div>
                ))}
                {group.products.pageInfo.hasNextPage && (
                  <span style={{ ...s.badge("gray"), fontSize: 11 }}>+ more</span>
                )}
              </div>
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#374151", marginBottom: 6 }}>Add products to this plan</div>
            <ProductPickerButton
              selectedProducts={selectedProducts}
              onSelect={setSelectedProducts}
              label="Select products to assign"
            />
          </div>

          {selectedProducts.length > 0 && (
            <Form method="post">
              <input type="hidden" name="intent" value="assignProduct" />
              <input type="hidden" name="planGroupId" value={group.id} />
              <input type="hidden" name="productIds" value={JSON.stringify(selectedProducts.map((p) => p.id))} />
              <button
                type="submit"
                style={{ ...s.submitBtn, padding: "8px 16px", fontSize: 13 }}
                disabled={isSubmitting}
              >
                {isSubmitting ? "Assigning…" : `Assign ${selectedProducts.length} product(s)`}
              </button>
            </Form>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Create Plan Form ─────────────────────────────────────────────────────────

function CreatePlanForm({ onCancel, isSubmitting }) {
  const [tieredDiscount, setTieredDiscount] = useState(false);
  const [shippingDiscount, setShippingDiscount] = useState(false);
  const [quantityChange, setQuantityChange] = useState(false);
  const [setMinQuantity, setSetMinQuantity] = useState(false);
  const [allowAutomaticActions, setAllowAutomaticActions] = useState(false);
  const [automaticActions, setAutomaticActions] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);

  const addAction = (type) => setAutomaticActions((prev) => [...prev, { type, afterCycle: 1 }]);
  const updateAction = (index, updated) => setAutomaticActions((prev) => prev.map((a, i) => (i === index ? updated : a)));
  const removeAction = (index) => setAutomaticActions((prev) => prev.filter((_, i) => i !== index));

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="create" />
      <input type="hidden" name="tieredDiscount" value={tieredDiscount ? "true" : "false"} />
      <input type="hidden" name="shippingDiscount" value={shippingDiscount ? "true" : "false"} />
      <input type="hidden" name="quantityChange" value={quantityChange ? "true" : "false"} />
      <input type="hidden" name="setMinQuantity" value={setMinQuantity ? "true" : "false"} />
      <input type="hidden" name="allowAutomaticActions" value={allowAutomaticActions ? "true" : "false"} />
      <input type="hidden" name="automaticActions" value={JSON.stringify(automaticActions)} />
      <input type="hidden" name="selectedProductIds" value={JSON.stringify(selectedProducts.map((p) => p.id))} />

      {/* ── Plan Details ── */}
      <SectionCard title="Plan Details">
        <div style={s.grid2}>
          <Field label="Plan Title" hint="Customers will see this on the storefront.">
            <input name="name" style={s.input} placeholder="e.g. Subscribe & Save" required />
          </Field>
          <SelectField
            label="Billing Type" name="billingType" defaultValue="DEFAULT"
            options={[{ value: "DEFAULT", label: "Pay as you go" }, { value: "PRE_PAID", label: "Pre-paid" }]}
          />
        </div>
        <div style={s.grid3}>
          <SelectField
            label="Billing Interval" name="interval" defaultValue="MONTH"
            options={[{ value: "DAY", label: "Days" }, { value: "WEEK", label: "Weeks" }, { value: "MONTH", label: "Months" }, { value: "YEAR", label: "Years" }]}
          />
          <Field label="Interval Count">
            <input name="intervalCount" type="number" defaultValue={1} min={1} style={s.input} required />
          </Field>
          <Field label="Subscription Discount (%)">
            <input name="discount" type="number" defaultValue={0} min={0} max={100} style={s.input} />
          </Field>
        </div>
      </SectionCard>

      {/* ── Assign Products ── */}
      <SectionCard title="Assign Products">
        <p style={{ ...s.hint, marginBottom: 10 }}>
          Optionally assign products to this plan right away. You can also do this later from the plan card.
        </p>
        <ProductPickerButton
          selectedProducts={selectedProducts}
          onSelect={setSelectedProducts}
          label="Select products for this plan"
        />
      </SectionCard>

      {/* ── Subscription Orders ── */}
      <SectionCard title="Subscription Orders">
        <div style={s.grid2}>
          <NumberSelect label="Minimum number of orders" name="minCycles" min={1} max={250} disabledLabel="Disabled" />
          <NumberSelect label="Maximum number of orders" name="maxCycles" min={1} max={250} disabledLabel="Unlimited" />
        </div>
      </SectionCard>

      {/* ── Subscription Discount ── */}
      <SectionCard title="Subscription Discount">
        <Toggle
          id="tieredDiscountToggle"
          label="Change discount after specific number of orders"
          description="Apply a different discount rate after a set number of orders."
          checked={tieredDiscount}
          onChange={(e) => setTieredDiscount(e.target.checked)}
        />
        {tieredDiscount && (
          <div style={{ ...s.grid3, marginTop: 12 }}>
            <Field label="New Discount Amount">
              <input name="tieredDiscountValue" type="number" defaultValue={0} min={0} max={100} style={s.input} />
            </Field>
            <Field label="After # of orders">
              <input name="tieredDiscountAfter" type="number" defaultValue={1} min={1} style={s.input} />
            </Field>
            <SelectField
              label="Discount Type" name="tieredDiscountType" defaultValue="PERCENTAGE"
              options={[{ value: "PERCENTAGE", label: "Percentage off" }, { value: "FIXED_AMOUNT", label: "Amount off" }, { value: "PRICE", label: "Fixed price" }]}
            />
          </div>
        )}
      </SectionCard>

      {/* ── Shipping Discount ── */}
      <SectionCard title="Shipping Discount">
        <Toggle
          id="shippingDiscountToggle"
          label="Give shipping discount"
          description="Override delivery price after a certain number of orders."
          checked={shippingDiscount}
          onChange={(e) => setShippingDiscount(e.target.checked)}
        />
        {shippingDiscount && (
          <div style={{ ...s.grid3, marginTop: 12 }}>
            <Field label="Discount Amount" hint="This will be the new delivery price">
              <input name="shippingDiscountValue" type="number" defaultValue={0} min={0} style={s.input} />
            </Field>
            <Field label="After # of orders" hint="After how many orders to change delivery price">
              <input name="shippingDiscountAfter" type="number" defaultValue={1} min={0} style={s.input} />
            </Field>
            <SelectField
              label="Discount Type" name="shippingDiscountType" defaultValue="PRICE"
              options={[{ value: "PERCENTAGE", label: "Percentage off" }, { value: "FIXED_AMOUNT", label: "Amount off" }, { value: "PRICE", label: "Fixed price" }]}
            />
          </div>
        )}
      </SectionCard>

      {/* ── Quantity Settings ── */}
      <SectionCard title="Quantity Settings">
        <Toggle
          id="quantityChangeToggle"
          label="Change product quantity after specific number of orders"
          description="This setting applies to selected products for both new and recurring subscription orders."
          checked={quantityChange}
          onChange={(e) => setQuantityChange(e.target.checked)}
        />
        {quantityChange && (
          <div style={{ ...s.grid2, marginTop: 12 }}>
            <Field label="Quantity" hint="Quantity will not be greater than the initial order quantity">
              <input name="quantityChangeValue" type="number" defaultValue={1} min={0} style={s.input} />
            </Field>
            <Field label="After # of orders" hint="After how many orders to change quantity">
              <input name="quantityChangeAfter" type="number" defaultValue={1} min={1} style={s.input} />
            </Field>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Toggle
            id="setMinQuantityToggle"
            label="Set minimum quantity for this plan"
            description="When this plan is selected, product quantity will automatically be set to this value and customers cannot select a lower quantity."
            checked={setMinQuantity}
            onChange={(e) => setSetMinQuantity(e.target.checked)}
          />
          {setMinQuantity && (
            <div style={{ marginTop: 12, maxWidth: 200 }}>
              <Field label="Minimum Quantity">
                <input name="minQuantity" type="number" defaultValue={1} min={1} style={s.input} />
              </Field>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Automatic Actions ── */}
      <SectionCard title="Automatic Actions">
        <Toggle
          id="automaticActionsToggle"
          label="Allow automatic actions (swap, add or remove products)"
          description="Automatic actions can change the subscription price. The price updates to the replacement product's price at the time of the swap."
          checked={allowAutomaticActions}
          onChange={(e) => { setAllowAutomaticActions(e.target.checked); if (!e.target.checked) setAutomaticActions([]); }}
        />
        {allowAutomaticActions && (
          <div style={{ marginTop: 16 }}>
            <div style={s.infoBanner}>
              ℹ️ Automatic actions can change the subscription price. The price updates to the replacement product's price at the time of the swap.
            </div>
            {automaticActions.length > 0 && (
              <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {automaticActions.map((action, i) => (
                  <ActionRow key={i} action={action} index={i} onChange={updateAction} onRemove={removeAction} />
                ))}
              </div>
            )}
            <AddActionDropdown onAdd={addAction} />
            {automaticActions.length === 0 && (
              <p style={{ ...s.hint, marginTop: 8 }}>No automatic actions configured yet. Click "Add action" to add one.</p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── Customer Product Changes ── */}
      <SectionCard title="Customer Product Changes">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Toggle id="allowSwaps" name="allowSwaps" label="Allow product swaps" description="Customers can swap their current product to a different product in this selling plan group via the customer portal." checked={true} />
          <Toggle id="allowVariantChanges" name="allowVariantChanges" label="Allow variant changes" description="Customers can change to a different variant of the same product (e.g., size, color)." checked={true} />
          <Toggle id="allowQuantityChanges" name="allowQuantityChanges" label="Allow quantity changes" description="Customers can change the quantity of their subscription items." checked={true} />
          <Toggle id="keepDiscounts" name="keepDiscounts" label="Keep discounts on product changes" description="Discounts and pricing policies will be preserved when customers swap products, change variants, or adjust quantities." checked={true} />
        </div>
      </SectionCard>

      <div style={s.formActions}>
        <button type="button" style={s.cancelBtn} onClick={onCancel}>Cancel</button>
        <button type="submit" style={s.submitBtn} disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create Plan"}
        </button>
      </div>
    </Form>
  );
}

// ─── Plan Billing Badge ───────────────────────────────────────────────────────

function PlanBillingBadge({ bp }) {
  if (bp?.interval) {
    return <span style={s.badge("blue")}>{bp.intervalCount} × {bp.interval}</span>;
  }
  if (bp?.remainingBalanceChargeTrigger) {
    return <span style={s.badge("blue")}>Pre-paid</span>;
  }
  return null;
}

// ─── Extra Settings Badges ────────────────────────────────────────────────────

function ExtraSettingsBadges({ group }) {
  const settings = group.extraSettings;
  if (!settings) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {settings.shippingDiscount?.enabled && (
        <span style={s.badge("blue")}>🚚 Shipping discount after {settings.shippingDiscount.after} orders</span>
      )}
      {settings.quantityChange?.enabled && (
        <span style={s.badge("purple")}>📦 Qty change after {settings.quantityChange.after} orders</span>
      )}
      {settings.minQuantity?.enabled && (
        <span style={s.badge("orange")}>Min qty: {settings.minQuantity.value}</span>
      )}
      {settings.automaticActions?.length > 0 && (
        <span style={s.badge("indigo")}>⚡ {settings.automaticActions.length} auto action(s)</span>
      )}
      {settings.customerChanges?.allowSwaps && <span style={s.badge("green")}>✓ Swaps</span>}
      {settings.customerChanges?.allowVariantChanges && <span style={s.badge("green")}>✓ Variants</span>}
      {settings.customerChanges?.allowQuantityChanges && <span style={s.badge("green")}>✓ Qty changes</span>}
      {settings.customerChanges?.keepDiscounts && <span style={s.badge("green")}>✓ Keep discounts</span>}
    </div>
  );
}

// ─── Activity Log ──────────────────────────────────────────────────────────────

function formatAuditTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

const AUDIT_ACTION_LABELS = {
  SHIPPING_DISCOUNT: "Shipping discount",
  QUANTITY_CHANGE: "Quantity change",
  PRODUCT_SWAP: "Product swap",
  VARIANT_SWAP: "Variant swap",
  ADD_PRODUCT: "Add product",
  REMOVE_PRODUCT: "Remove product",
  REMOVE_VARIANT: "Remove variant",
};

function ActivityLogPanel({ auditLog, sellingPlanGroups }) {
  const [expanded, setExpanded] = useState(false);
  if (!auditLog || auditLog.length === 0) return null;

  const normalizeId = (id) => id?.startsWith("gid://") ? id : `gid://shopify/SellingPlanGroup/${id}`;
  const groupNameById = new Map(sellingPlanGroups.map((g) => [normalizeId(g.id), g.name]));

  const visibleEntries = expanded ? auditLog : auditLog.slice(0, 5);

  return (
    <SectionCard title={`Activity Log (${auditLog.length})`}>
      <p style={{ ...s.hint, marginBottom: 12 }}>
        Automatic actions (shipping discounts, quantity changes, product swaps) applied
        to upcoming billing cycles before they were charged.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visibleEntries.map((entry, i) => (
          <div key={i} style={s.auditRow}>
            <span style={{ fontSize: 16 }}>{entry.status === "success" ? "✅" : "❌"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {groupNameById.get(normalizeId(entry.groupId)) || "Unknown plan"} — Cycle #{entry.cycleIndex}
              </div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                {(entry.actions || []).map((a) => AUDIT_ACTION_LABELS[a] || a).join(", ")}
              </div>
              {entry.status === "failed" && entry.error && (
                <div style={{ fontSize: 12, color: "#991b1b", marginTop: 2 }}>{entry.error}</div>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" }}>
              {formatAuditTimestamp(entry.appliedAt)}
            </div>
          </div>
        ))}
      </div>
      {auditLog.length > 5 && (
        <button
          type="button"
          style={{ ...s.assignProductsBtn, marginTop: 12 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▲ Show less" : `▼ Show all ${auditLog.length}`}
        </button>
      )}
    </SectionCard>
  );
}
// ─── Page ──────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const { sellingPlanGroups, auditLog } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [showForm, setShowForm] = useState(false);
  const isSubmitting = navigation.state === "submitting";
  useEffect(() => {
    if (actionData?.created) setShowForm(false);
  }, [actionData]);

  return (
    <s-page heading="Selling Plans">
      {actionData?.success && <div style={s.alert("success")}>{actionData.success}</div>}
      {actionData?.error && <div style={s.alert("error")}>{actionData.error}</div>}

      <div style={{ marginBottom: 20 }}>
        {!showForm && (
          <button style={s.primaryBtn} onClick={() => setShowForm(true)}>+ Create New Plan</button>
        )}
      </div>

      {showForm && <CreatePlanForm onCancel={() => setShowForm(false)} isSubmitting={isSubmitting} />}

      <ActivityLogPanel auditLog={auditLog} sellingPlanGroups={sellingPlanGroups} />

      <SectionCard title={`All Selling Plan Groups (${sellingPlanGroups.length})`}>
        {sellingPlanGroups.length === 0 ? (
          <div style={s.empty}>No selling plans yet. Create your first one!</div>
        ) : (
          sellingPlanGroups.map((group) => (
            <div key={group.id} style={s.planCard}>
              <div style={s.planHeader}>
                <div>
                  <h3 style={s.planName}>{group.name}</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                    <span style={s.badge("gray")}>{group.merchantCode}</span>
                    <span style={s.badge("indigo")}>
                      {group.products.edges.length}{group.products.pageInfo.hasNextPage ? "+" : ""} products
                    </span>
                  </div>
                  <ExtraSettingsBadges group={group} />
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="planGroupId" value={group.id} />
                  <button style={s.deleteBtn} type="submit">🗑 Delete</button>
                </Form>
              </div>

              <div style={s.plansInner}>
                {group.sellingPlans.edges.map(({ node: plan }) => {
                  const bp = plan.billingPolicy;
                  const fixedPricing = plan.pricingPolicies?.find((p) => !p.afterCycle);
                  const tieredPricing = plan.pricingPolicies?.find((p) => p.afterCycle);
                  const pct = fixedPricing?.adjustmentValue?.percentage;
                  const tieredPct = tieredPricing?.adjustmentValue?.percentage;
                  return (
                    <div key={plan.id} style={s.planRow}>
                      <span>📅 {plan.name}</span>
                      <PlanBillingBadge bp={bp} />
                      {bp?.minCycles > 0 && <span style={s.badge("purple")}>min {bp.minCycles} orders</span>}
                      {bp?.maxCycles > 0 && <span style={s.badge("orange")}>max {bp.maxCycles} orders</span>}
                      {pct > 0 && <span style={s.badge("green")}>-{pct}% off</span>}
                      {tieredPct > 0 && (
                        <span style={s.badge("indigo")}>-{tieredPct}% after {tieredPricing.afterCycle} orders</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <AssignProductsPanel group={group} />
            </div>
          ))
        )}
      </SectionCard>
    </s-page>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  alert: (type) => ({
    padding: "12px 16px", borderRadius: 8, marginBottom: 16,
    background: type === "success" ? "#d1fae5" : "#fee2e2",
    color: type === "success" ? "#065f46" : "#991b1b", fontWeight: 500,
  }),
  card: { background: "white", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 16, marginTop: 0, paddingBottom: 12, borderBottom: "1px solid #f3f4f6", color: "#111827" },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 13, fontWeight: 500, color: "#374151" },
  hint: { fontSize: 12, color: "#9ca3af", margin: 0 },
  input: { padding: "9px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, width: "100%", boxSizing: "border-box", background: "white" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 },
  toggleRow: { display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "8px 0" },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 8, marginBottom: 24 },
  primaryBtn: { padding: "10px 20px", background: "#4f46e5", color: "white", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 14 },
  submitBtn: { padding: "10px 24px", background: "#10b981", color: "white", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 14 },
  cancelBtn: { padding: "10px 20px", background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, cursor: "pointer", fontWeight: 500, fontSize: 14 },
  empty: { textAlign: "center", color: "#9ca3af", padding: 40 },
  planCard: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, marginBottom: 12 },
  planHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  planName: { fontSize: 15, fontWeight: 600, margin: "0 0 6px 0" },
  badge: (color) => {
    const colors = {
      gray: { background: "#f3f4f6", color: "#6b7280" },
      indigo: { background: "#ede9fe", color: "#4f46e5" },
      blue: { background: "#dbeafe", color: "#1e40af" },
      green: { background: "#d1fae5", color: "#065f46" },
      purple: { background: "#f3e8ff", color: "#7e22ce" },
      orange: { background: "#fff7ed", color: "#c2410c" },
    };
    return { fontSize: 11, padding: "2px 8px", borderRadius: 10, marginRight: 6, fontWeight: 500, display: "inline-block", ...colors[color] };
  },
  deleteBtn: { padding: "6px 12px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 },
  plansInner: { background: "#f9fafb", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  planRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" },
  assignProductsBtn: { padding: "7px 14px", background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: 7, cursor: "pointer", fontWeight: 500, fontSize: 13 },
  assignedProductChip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", background: "#ede9fe", borderRadius: 20, border: "1px solid #c4b5fd", color: "#4f46e5" },
  addActionBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, cursor: "pointer", fontWeight: 500, fontSize: 13 },
  dropdown: { position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50, background: "white", border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 260, overflow: "hidden" },
  dropdownGroup: { padding: "12px 16px 4px", fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" },
  dropdownItem: { display: "block", width: "100%", textAlign: "left", padding: "9px 16px", border: "none", background: "transparent", fontSize: 14, color: "#111827", cursor: "pointer" },
  dropdownDivider: { height: 1, background: "#f3f4f6", margin: "4px 0" },
  infoBanner: { padding: "10px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, fontSize: 13, color: "#1e40af", marginBottom: 12 },
  actionRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: 14, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, gap: 12 },
  actionRowLeft: { display: "flex", gap: 10, alignItems: "flex-start", flex: 1 },
  actionIcon: { fontSize: 20, lineHeight: 1, marginTop: 1 },
  removeActionBtn: { padding: "8px 10px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, flexShrink: 0, alignSelf: "flex-start" },
  selectedProduct: { display: "flex", alignItems: "center", gap: 10, marginTop: 8, padding: "8px 12px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8 },
  selectProductBtn: { padding: "7px 14px", background: "white", color: "#4f46e5", border: "1px solid #c7d2fe", borderRadius: 7, cursor: "pointer", fontWeight: 500, fontSize: 13 },
  changeProductBtn: { padding: "4px 10px", background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: 6, cursor: "pointer", fontSize: 12, marginLeft: "auto" },
  auditRow: { display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8 },
};