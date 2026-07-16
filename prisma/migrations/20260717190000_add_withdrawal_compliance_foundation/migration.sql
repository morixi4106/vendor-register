ALTER TABLE "withdrawal_requests"
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "submittedViewLocale" TEXT,
  ADD COLUMN "correspondenceLocale" TEXT,
  ADD COLUMN "localeSource" TEXT,
  ADD COLUMN "shippingCountryAtOrder" TEXT,
  ADD COLUMN "shopifyMarketCountry" TEXT,
  ADD COLUMN "consumerHabitualResidenceCountry" TEXT,
  ADD COLUMN "consumerLawCountry" TEXT,
  ADD COLUMN "consumerLawCountrySource" TEXT,
  ADD COLUMN "consumerLawRuleVersion" TEXT,
  ADD COLUMN "consumerLawDeterminedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalInformationProvidedAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalDeadlineRuleVersion" TEXT,
  ADD COLUMN "purchaseWithdrawalTermsVersion" TEXT,
  ADD COLUMN "purchaseWithdrawalTermsLocale" TEXT,
  ADD COLUMN "purchaseWithdrawalTermsProvidedAt" TIMESTAMP(3),
  ADD COLUMN "purchaseWithdrawalTermsDeliveryMethod" TEXT,
  ADD COLUMN "submissionLegalBundleVersion" TEXT,
  ADD COLUMN "submissionLegalBundleHash" TEXT,
  ADD COLUMN "submittedPayloadSchemaVersion" INTEGER,
  ADD COLUMN "submittedPayloadHash" TEXT;

UPDATE "withdrawal_requests"
SET
  "submittedAt" = COALESCE("submittedAt", "createdAt"),
  "submittedViewLocale" = COALESCE("submittedViewLocale", 'ja-JP'),
  "correspondenceLocale" = COALESCE("correspondenceLocale", 'ja-JP'),
  "localeSource" = COALESCE("localeSource", 'LEGACY_MIGRATION'),
  "submittedPayloadSchemaVersion" = COALESCE("submittedPayloadSchemaVersion", 1)
WHERE "submittedAt" IS NULL
   OR "submittedViewLocale" IS NULL
   OR "correspondenceLocale" IS NULL
   OR "localeSource" IS NULL
   OR "submittedPayloadSchemaVersion" IS NULL;

CREATE INDEX "withdrawal_requests_correspondenceLocale_createdAt_idx"
  ON "withdrawal_requests"("correspondenceLocale", "createdAt");
CREATE INDEX "withdrawal_requests_consumerLawCountry_createdAt_idx"
  ON "withdrawal_requests"("consumerLawCountry", "createdAt");
CREATE INDEX "withdrawal_requests_submittedAt_idx"
  ON "withdrawal_requests"("submittedAt");

CREATE TABLE "withdrawal_events" (
  "id" TEXT NOT NULL,
  "withdrawalRequestId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "payloadJson" JSONB,
  "payloadHash" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "withdrawal_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawal_events_idempotencyKey_key"
  ON "withdrawal_events"("idempotencyKey");
CREATE INDEX "withdrawal_events_withdrawalRequestId_occurredAt_idx"
  ON "withdrawal_events"("withdrawalRequestId", "occurredAt");
CREATE INDEX "withdrawal_events_type_occurredAt_idx"
  ON "withdrawal_events"("type", "occurredAt");

CREATE TABLE "withdrawal_email_outbox" (
  "id" TEXT NOT NULL,
  "withdrawalRequestId" TEXT NOT NULL,
  "withdrawalEventId" TEXT NOT NULL,
  "messageType" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "sender" TEXT,
  "locale" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "subjectSnapshot" TEXT NOT NULL,
  "textBodySnapshot" TEXT NOT NULL,
  "htmlBodySnapshot" TEXT NOT NULL,
  "renderedContentHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "bouncedAt" TIMESTAMP(3),
  "complainedAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_email_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawal_email_outbox_idempotencyKey_key"
  ON "withdrawal_email_outbox"("idempotencyKey");
CREATE INDEX "withdrawal_email_outbox_status_nextAttemptAt_idx"
  ON "withdrawal_email_outbox"("status", "nextAttemptAt");
CREATE INDEX "withdrawal_email_outbox_withdrawalRequestId_createdAt_idx"
  ON "withdrawal_email_outbox"("withdrawalRequestId", "createdAt");
CREATE INDEX "withdrawal_email_outbox_lockedUntil_idx"
  ON "withdrawal_email_outbox"("lockedUntil");

CREATE TABLE "withdrawal_legal_bundles" (
  "id" TEXT NOT NULL,
  "consumerLawCountry" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "title" TEXT NOT NULL,
  "contentJson" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "publishedBy" TEXT,
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_legal_bundles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawal_legal_bundles_country_locale_version_key"
  ON "withdrawal_legal_bundles"("consumerLawCountry", "locale", "version");
CREATE INDEX "withdrawal_legal_bundles_country_locale_status_idx"
  ON "withdrawal_legal_bundles"("consumerLawCountry", "locale", "status");

ALTER TABLE "vendor_return_addresses"
  ADD COLUMN "internationalRecipientName" TEXT,
  ADD COLUMN "internationalAddressLines" JSONB,
  ADD COLUMN "phoneE164" TEXT;

CREATE TABLE "vendor_return_address_locales" (
  "id" TEXT NOT NULL,
  "returnAddressId" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "returnInstructions" TEXT,
  "recipientDisplayName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_return_address_locales_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_return_address_locales_address_locale_key"
  ON "vendor_return_address_locales"("returnAddressId", "locale");
CREATE INDEX "vendor_return_address_locales_locale_idx"
  ON "vendor_return_address_locales"("locale");

ALTER TABLE "withdrawal_events"
  ADD CONSTRAINT "withdrawal_events_withdrawalRequestId_fkey"
  FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "withdrawal_email_outbox"
  ADD CONSTRAINT "withdrawal_email_outbox_withdrawalRequestId_fkey"
  FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "withdrawal_email_outbox"
  ADD CONSTRAINT "withdrawal_email_outbox_withdrawalEventId_fkey"
  FOREIGN KEY ("withdrawalEventId") REFERENCES "withdrawal_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vendor_return_address_locales"
  ADD CONSTRAINT "vendor_return_address_locales_returnAddressId_fkey"
  FOREIGN KEY ("returnAddressId") REFERENCES "vendor_return_addresses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
