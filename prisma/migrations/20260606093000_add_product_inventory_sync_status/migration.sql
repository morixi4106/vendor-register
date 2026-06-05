ALTER TABLE "Product"
ADD COLUMN "inventorySyncedAt" TIMESTAMP(3),
ADD COLUMN "inventorySyncError" TEXT;
