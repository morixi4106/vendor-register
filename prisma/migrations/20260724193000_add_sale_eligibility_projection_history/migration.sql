CREATE TABLE "sale_eligibility_projection_revisions" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "vendorStoreId" TEXT,
    "destinationCountry" TEXT NOT NULL DEFAULT '',
    "salesChannel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "requirementVersions" JSONB NOT NULL,
    "decisionIds" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "projectionRevision" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_eligibility_projection_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sale_eligibility_projection_revisions_identity_revision_key"
ON "sale_eligibility_projection_revisions"(
    "shopDomain",
    "productId",
    "destinationCountry",
    "salesChannel",
    "projectionRevision"
);

CREATE INDEX "sale_eligibility_projection_revisions_temporal_idx"
ON "sale_eligibility_projection_revisions"(
    "shopDomain",
    "productId",
    "destinationCountry",
    "salesChannel",
    "evaluatedAt",
    "expiresAt"
);

CREATE INDEX "sale_eligibility_projection_revisions_status_expiresAt_idx"
ON "sale_eligibility_projection_revisions"("status", "expiresAt");

ALTER TABLE "sale_eligibility_projection_revisions"
ADD CONSTRAINT "sale_eligibility_projection_revisions_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "sale_eligibility_projection_revisions" (
    "id",
    "shopDomain",
    "productId",
    "vendorStoreId",
    "destinationCountry",
    "salesChannel",
    "status",
    "reasonCodes",
    "requirementVersions",
    "decisionIds",
    "policyVersion",
    "inputHash",
    "projectionRevision",
    "evaluatedAt",
    "expiresAt",
    "createdAt"
)
SELECT
    CONCAT('legacy_', "id"),
    "shopDomain",
    "productId",
    "vendorStoreId",
    "destinationCountry",
    "salesChannel",
    "status",
    "reasonCodes",
    "requirementVersions",
    "decisionIds",
    "policyVersion",
    "inputHash",
    "projectionRevision",
    "evaluatedAt",
    "expiresAt",
    "createdAt"
FROM "sale_eligibility_projections"
ON CONFLICT DO NOTHING;
