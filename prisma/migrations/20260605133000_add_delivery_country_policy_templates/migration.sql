CREATE TABLE IF NOT EXISTS "delivery_country_policy_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryName" TEXT,
    "description" TEXT,
    "productEuStatus" TEXT NOT NULL DEFAULT 'DISABLED',
    "allowedCountries" JSONB,
    "blockedCountries" JSONB,
    "requiresWarningCountries" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_country_policy_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_country_policy_templates_name_key"
    ON "delivery_country_policy_templates"("name");

CREATE INDEX IF NOT EXISTS "delivery_country_policy_templates_isActive_name_idx"
    ON "delivery_country_policy_templates"("isActive", "name");
