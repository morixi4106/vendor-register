ALTER TABLE "VendorStore"
ADD COLUMN "isTestStore" BOOLEAN NOT NULL DEFAULT false;

UPDATE "VendorStore"
SET "isTestStore" = true;
