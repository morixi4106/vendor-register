import assert from "node:assert/strict";
import path from "node:path";

// Every record is synthetic and lives only in the caller's loopback databases.
export async function probeInternational({
  client,
  PrismaClient,
  input,
  url,
  command,
  record,
}) {
  const now = new Date("2026-11-07T00:00:00Z"),
    later = new Date("2026-11-08T00:00:00Z");
  const shop = "international.synthetic.invalid",
    other = "other.synthetic.invalid",
    digest = "a".repeat(64);
  const migrationCount = input.inputs.filter((e) =>
    e.path.endsWith("/migration.sql"),
  ).length;
  let rejections = 0;
  const rejected = async (operation, code, constraint) => {
    await assert.rejects(
      operation,
      (error) =>
        error.code === code &&
        (!constraint ||
          (error.meta?.code === "23514" &&
            error.meta?.message.includes(constraint))),
    );
    rejections++;
  };
  await record("international-upgrade-existing-data", async () => {
    const upgrade = new PrismaClient({
      datasourceUrl: url("oja_upgrade_probe"),
      log: [],
    });
    try {
      command(input.upgradeProject, ["migrate", "deploy"], "oja_upgrade_probe");
      const before = await upgrade.$queryRawUnsafe(
        'SELECT id,migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      assert.equal(before.length, migrationCount - 5);
      await upgrade.$executeRaw`INSERT INTO operational_readiness_attestations (id,"checkKey",notes,"updatedAt") VALUES ('synthetic-attestation','synthetic-check','preserve evidence',${now})`;
      await upgrade.$executeRaw`INSERT INTO international_shipping_country_availabilities (id,"countryCode",note,"updatedAt") VALUES ('synthetic-shipping','ZZ','preserve availability',${now})`;
      command(input.project, ["migrate", "deploy"], "oja_upgrade_probe");
      command(input.project, ["migrate", "deploy"], "oja_upgrade_probe");
      const after = await upgrade.$queryRawUnsafe(
        'SELECT id,migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      assert.equal(after.length, migrationCount);
      assert.deepEqual(
        after.filter((row) => before.some((old) => old.id === row.id)),
        before,
      );
      for (const entry of input.inputs.filter((e) =>
        e.path.endsWith("/migration.sql"),
      ))
        assert.equal(
          after.find((row) => row.migration_name === entry.path.split("/")[2])
            .checksum,
          entry.sha256,
        );
      const attestation =
        await upgrade.operationalReadinessAttestation.findUnique({
          where: { id: "synthetic-attestation" },
        });
      const shipping =
        await upgrade.internationalShippingCountryAvailability.findUnique({
          where: { id: "synthetic-shipping" },
        });
      assert.equal(attestation.revision, 0);
      assert.equal(attestation.notes, "preserve evidence");
      assert.equal(attestation.status, "PENDING");
      assert.equal(shipping.revision, 0);
      assert.equal(shipping.note, "preserve availability");
      assert.equal(shipping.status, "UNKNOWN");
      command(
        input.project,
        [
          "migrate",
          "diff",
          "--from-url",
          url("oja_upgrade_probe"),
          "--to-schema-datamodel",
          path.join(input.project, "prisma/schema.prisma"),
          "--exit-code",
        ],
        "oja_upgrade_probe",
      );
      await upgrade.operationalReadinessAttestation.delete({
        where: { id: attestation.id },
      });
      await upgrade.internationalShippingCountryAvailability.delete({
        where: { id: shipping.id },
      });
    } finally {
      await upgrade.$disconnect();
    }
  });
  let auth, delivery, run, job;
  try {
    await record("international-defaults-and-authorization", async () => {
      for (const domain of [shop, other]) {
        const state = await client.internationalGateSyncState.create({
          data: { shopDomain: domain },
        });
        assert.equal(state.mode, "DISABLED");
        assert.equal(state.phase, "UNCONFIGURED");
        assert.equal(state.snapshotComplete, false);
        assert.deepEqual(state.authorizedScopeJson, []);
        assert.equal(state.desiredGeneration, 0);
        assert.equal(state.appliedGeneration, 0);
      }
      auth = await client.internationalGateAuthorizationRequest.create({
        data: {
          shopDomain: shop,
          actorKey: "synthetic",
          purpose: "VERIFY",
          verificationKind: "NON_FINANCIAL",
          operatorJson: { synthetic: true },
          scopeJson: [],
          scopeHash: digest,
          currenciesJson: ["JPY"],
          requestedExpiresAt: later,
          effectiveExpiresAt: later,
          expectedGeneration: 0,
          sourceHash: digest,
          proofReferencesJson: [],
          nativeConfigHash: digest,
          releaseBinding: "synthetic",
          shopTimezone: "Asia/Tokyo",
          nonceHash: digest,
          previewExpiresAt: later,
        },
      });
      const check = "international_authorization_shape";
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "currenciesJson"='["USD"]'::jsonb WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET purpose='INVALID' WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "resumePurpose"='SALE' WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "consumedAt"=${now} WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "expectedGeneration"=-1 WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "effectiveExpiresAt"=${new Date("2026-11-09T00:00:00Z")} WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalGateAuthorizationRequest" SET "nonceHash"='invalid' WHERE id=${auth.id}`,
        "P2010",
        check,
      );
      const { id, createdAt, ...duplicate } = auth;
      await rejected(
        client.internationalGateAuthorizationRequest.create({
          data: duplicate,
        }),
        "P2002",
      );
      job = await client.internationalGateSyncJob.create({
        data: {
          shopDomain: other,
          generation: 1,
          targetType: "SHOP",
          targetId: "synthetic",
        },
      });
      assert.equal(job.status, "PENDING");
      assert.equal(job.attempts, 0);
      await rejected(
        client.internationalGateSyncState.update({
          where: { shopDomain: other },
          data: { authorizationRequestId: auth.id },
        }),
        "P2003",
      );
      await rejected(
        client.internationalGateSyncJob.update({
          where: { id: job.id },
          data: { authorizationRequestId: auth.id },
        }),
        "P2003",
      );
      await client.internationalGateAuthorizationRequest.update({
        where: { id: auth.id },
        data: {
          consumedAt: now,
          consumedGeneration: 1,
          resultCode: "ACCEPTED",
        },
      });
    });
    await record("international-proof-delivery", async () => {
      delivery = await client.internationalProofDelivery.create({
        data: {
          shopDomain: shop,
          appId: "synthetic",
          receiptId: "synthetic-receipt",
          receiptJson: { synthetic: true },
          receiptDigest: digest,
          artifactId: 1,
          headSha: "b".repeat(40),
          versionTag: "synthetic",
          allowedUseUntil: later,
          receivedBy: "synthetic",
        },
      });
      const check = "international_delivery_payload_bounds";
      await rejected(
        client.$executeRaw`UPDATE "InternationalProofDelivery" SET "receiptJson"=${JSON.stringify({ value: "x".repeat(32000) })}::jsonb WHERE id=${delivery.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalProofDelivery" SET "receiptDigest"='invalid' WHERE id=${delivery.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalProofDelivery" SET "headSha"='invalid' WHERE id=${delivery.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalProofDelivery" SET "artifactId"=0 WHERE id=${delivery.id}`,
        "P2010",
        check,
      );
      const { id, createdAt, ...duplicate } = delivery;
      await rejected(
        client.internationalProofDelivery.create({ data: duplicate }),
        "P2002",
      );
    });
    await record("international-run-closure-and-tenancy", async () => {
      run = await client.internationalCheckoutVerificationRun.create({
        data: {
          shopDomain: other,
          kind: "DEPLOYMENT",
          initiatedBy: "synthetic",
          scenarioVersion: "synthetic",
          verifierVersion: "synthetic",
          scopeHash: digest,
          releaseBinding: "synthetic",
          nativeConfigHash: digest,
          proofReferencesJson: [],
          requiredCasesHash: digest,
          startGeneration: 0,
          activeKey: `${other}:DEPLOYMENT`,
          expiresAt: later,
        },
      });
      const check = "international_verification_shape";
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET status='PASSED' WHERE id=${run.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET status='RUNNING' WHERE id=${run.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET "activeKey"=NULL WHERE id=${run.id}`,
        "P2010",
        check,
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET "revokedAt"=${now} WHERE id=${run.id}`,
        "P2010",
        "international_proof_shape",
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET "observationJson"='{}'::jsonb WHERE id=${run.id}`,
        "P2010",
        "international_proof_shape",
      );
      await rejected(
        client.$executeRaw`UPDATE "InternationalCheckoutVerificationRun" SET "preparationRequestKey"='00000000-0000-0000-0000-000000000000' WHERE id=${run.id}`,
        "P2010",
        "international_preparation_binding",
      );
      await rejected(
        client.internationalCheckoutVerificationRun.update({
          where: { id: run.id },
          data: { authorizationRequestId: auth.id },
        }),
        "P2003",
      );
      await rejected(
        client.internationalCheckoutVerificationRun.update({
          where: { id: run.id },
          data: {
            proofDeliveryId: delivery.id,
            preparationRequestKey: "00000000-0000-0000-0000-000000000000",
          },
        }),
        "P2003",
      );
      const { id, createdAt, ...duplicate } = run;
      // Prisma's JSON null is not SQL NULL; leave the optional observation absent.
      delete duplicate.observationJson;
      delete duplicate.resultsJson;
      await rejected(
        client.internationalCheckoutVerificationRun.create({ data: duplicate }),
        "P2002",
      );
      const closed = await client.internationalCheckoutVerificationRun.update({
        where: { id: run.id },
        data: {
          status: "PASSED",
          closureStatus: "CONFIRMED",
          activeKey: null,
          artifactHash: digest,
          completedAt: now,
        },
      });
      assert.equal(closed.status, "PASSED");
      assert.equal(closed.activeKey, null);
    });
    assert.equal(rejections, 24);
    return {
      baselineMigrations: migrationCount - 5,
      migrationsAdded: 5,
      rowsPreserved: 2,
      rejections,
      defaultsDisabled: true,
    };
  } finally {
    if (run)
      await client.internationalCheckoutVerificationRun.delete({
        where: { id: run.id },
      });
    for (const domain of [other, shop])
      await client.internationalGateSyncState.deleteMany({
        where: { shopDomain: domain },
      });
    if (auth)
      await client.internationalGateAuthorizationRequest.delete({
        where: { id: auth.id },
      });
    if (delivery)
      await client.internationalProofDelivery.delete({
        where: { id: delivery.id },
      });
  }
}
