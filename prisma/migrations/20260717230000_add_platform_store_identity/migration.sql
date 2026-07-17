ALTER TABLE "VendorStore"
ADD COLUMN "isPlatformStore" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "VendorStore_single_platform_store_key"
ON "VendorStore" ("isPlatformStore")
WHERE "isPlatformStore" = true;

INSERT INTO "VendorStore" (
  "id",
  "ownerName",
  "storeName",
  "email",
  "phone",
  "address",
  "country",
  "category",
  "note",
  "ageCheck",
  "isTestStore",
  "isPlatformStore",
  "createdAt",
  "updatedAt"
)
SELECT
  'platform_store_oja_immanuel_bacchus',
  'Oja Immanuel Bacchus',
  'Oja Immanuel Bacchus',
  'support@oja-immanuel-bacchus.com',
  '-',
  'Managed by the platform. This is not a return address.',
  'JP',
  '生活',
  'Internal platform storefront used to attribute Shopify-admin products.',
  'not_required',
  false,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "VendorStore" WHERE "isPlatformStore" = true
);

INSERT INTO "Vendor" (
  "id",
  "vendorStoreId",
  "storeName",
  "handle",
  "managementEmail",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  'platform_vendor_oja_immanuel_bacchus',
  store."id",
  store."storeName",
  'oja-platform-direct',
  store."email",
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "VendorStore" store
WHERE store."isPlatformStore" = true
  AND NOT EXISTS (
    SELECT 1 FROM "Vendor" vendor WHERE vendor."vendorStoreId" = store."id"
  );

INSERT INTO "sellers" (
  "id",
  "vendorId",
  "vendorStoreId",
  "status",
  "statusReason",
  "sellerLegalRole",
  "sellerVerificationStatus",
  "euSellerStatus",
  "documentVerificationStatus",
  "verificationNameMatched",
  "payoutNameMatched",
  "createdAt",
  "updatedAt"
)
SELECT
  'platform_seller_oja_immanuel_bacchus',
  vendor."id",
  store."id",
  'active',
  'Internal platform operator account; excluded from seller payout and sales credit.',
  'PLATFORM_OPERATOR',
  'NONE',
  'DISABLED',
  'NONE',
  false,
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "VendorStore" store
JOIN "Vendor" vendor ON vendor."vendorStoreId" = store."id"
WHERE store."isPlatformStore" = true
  AND NOT EXISTS (
    SELECT 1 FROM "sellers" seller WHERE seller."vendorStoreId" = store."id"
  );
