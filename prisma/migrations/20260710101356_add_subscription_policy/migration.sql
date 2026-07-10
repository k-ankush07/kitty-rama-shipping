-- CreateTable
CREATE TABLE "SubscriptionPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionContractId" TEXT NOT NULL,
    "minPaymentsRequired" INTEGER NOT NULL DEFAULT 0,
    "paymentsCompleted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPolicy_subscriptionContractId_key" ON "SubscriptionPolicy"("subscriptionContractId");
