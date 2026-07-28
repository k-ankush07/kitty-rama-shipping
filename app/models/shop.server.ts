// app/models/shop.server.ts

export type ShopRecord = {
  shopDomain: string;
  accessToken: string;
  scope: string;
  onboardingCompleted: boolean;
  installedAt: Date;
};

// DEMO ONLY: In-memory map (server restart hoga to data ud jayega)
const shops = new Map<string, ShopRecord>();

export async function getShopRecord(shopDomain: string): Promise<ShopRecord | null> {
  return shops.get(shopDomain) ?? null;
}

export async function upsertShopRecord(input: {
  shopDomain: string;
  accessToken: string;
  scope: string;
}) {
  const existing = shops.get(input.shopDomain);
  const record: ShopRecord = {
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
    scope: input.scope,
    onboardingCompleted: existing?.onboardingCompleted ?? false,
    installedAt: existing?.installedAt ?? new Date(),
  };
  shops.set(input.shopDomain, record);
  return record;
}

export async function setOnboardingCompleted(shopDomain: string) {
  const existing = shops.get(shopDomain);
  if (!existing) return;
  shops.set(shopDomain, {
    ...existing,
    onboardingCompleted: true,
  });
}