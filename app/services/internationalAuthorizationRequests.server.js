import prisma from "../db.server.js";
import { MARKETPLACE_OPERATOR_ROLES as ROLES } from "../utils/marketplaceOperatorRoles.js";
import { requirePostRequest } from "../utils/internalRouteSecurity.server.js";
import { invalidateInternationalGates } from "./internationalGateQueue.server.js";
import {
  authorizationError,
  assertInternationalShop,
  authorizationExpiry,
  effectiveAuthorizationPurpose,
  hashInternationalSecret,
  inspectInternationalAuthorizationCapability,
  internationalAuthorizationTransaction,
  INTERNATIONAL_SYSTEM_EVIDENCE_KEYS,
  INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
  INTERNATIONAL_RELEASE_EVIDENCE_KEY,
  matchesInternationalSecret,
  newInternationalSecret,
  normalizeInternationalAuthorization,
  PREVIEW_TTL_MS,
} from "./internationalAuthorizationPolicy.server.js";
import {
  collectInternationalAuthorizationSource,
  inspectInternationalAuthorizationContext,
} from "./internationalAuthorizationContext.server.js";
import {
  internationalHash,
  internationalLocalDate,
} from "./internationalGateProjection.server.js";

function proofReferences(references) {
  if (
    !Array.isArray(references) ||
    !references.length ||
    references.length > 20 ||
    references.some(
      (row) =>
        !row ||
        Object.keys(row).some(
          (key) => !["id", "revision", "evidenceHash"].includes(key),
        ) ||
        typeof row.id !== "string" ||
        row.id.length > 128 ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        !/^[a-f0-9]{64}$/.test(row.evidenceHash || ""),
    )
  )
    throw authorizationError("international_proof_changed");
  const sorted = [...references].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(sorted.map((row) => row.id)).size !== sorted.length)
    throw authorizationError("international_proof_changed");
  return sorted;
}

function assertContext(context, now) {
  if (
    !context?.ready ||
    ![
      context.nativeConfigHash,
      context.releaseBinding,
      context.requiredCasesHash,
    ].every((hash) => /^[a-f0-9]{64}$/.test(hash || "")) ||
    !context.scenarioVersion ||
    !context.verifierVersion ||
    !context.shopTimezone ||
    !Array.isArray(context.proofReferences) ||
    !context.proofReferences.length ||
    context.proofReferences.length > 20 ||
    !context.observedAt ||
    !Number.isFinite(new Date(context.observedAt).getTime()) ||
    new Date(context.observedAt) > now ||
    now - new Date(context.observedAt) > 60000
  )
    throw authorizationError("international_authorization_unverified", 422);
  proofReferences(context.proofReferences);
}

async function assertProofs(
  tx,
  shopDomain,
  references,
  now,
  expiresAt,
  purpose,
) {
  const keys = new Set();
  for (const reference of references) {
    const row = await tx.operationalReadinessAttestation.findUnique({
      where: { id: reference.id },
    });
    if (
      !row ||
      !INTERNATIONAL_SYSTEM_EVIDENCE_KEYS.includes(row.checkKey) ||
      row.scopeType !== "SHOP" ||
      row.scopeId !== shopDomain ||
      row.status !== "CONFIRMED" ||
      row.revision !== reference.revision ||
      row.evidenceHash !== reference.evidenceHash ||
      row.confirmedBy !== "system:international-checkout-verifier" ||
      !row.confirmedAt ||
      row.confirmedAt > now ||
      !row.expiresAt ||
      row.expiresAt <= now ||
      row.expiresAt < expiresAt
    )
      throw authorizationError("international_proof_changed");
    keys.add(row.checkKey);
  }
  if (
    !keys.has(
      purpose === "VERIFY"
        ? INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY
        : INTERNATIONAL_RELEASE_EVIDENCE_KEY,
    )
  )
    throw authorizationError("international_proof_level_invalid", 422);
}

function checkMode(state, input) {
  if ((state?.mode === "STOPPED") !== (input.purpose === "RESUME"))
    throw authorizationError("international_recovery_required");
  if (
    input.purpose === "RESUME" &&
    (!state.protectedAt ||
      state.phase !== "BLOCKED" ||
      state.desiredGeneration !== state.appliedGeneration)
  )
    throw authorizationError("international_stop_unverified");
}

function fromRow(row) {
  return {
    purpose: row.purpose,
    resumePurpose: row.resumePurpose,
    verificationKind: row.verificationKind,
    scope: row.scopeJson,
    scopeHash: row.scopeHash,
    currencies: row.currenciesJson,
    requestedExpiresAt: row.requestedExpiresAt,
  };
}

// Only server-owned dependencies are injectable; none are read from the HTTP body.
export function createInternationalAuthorizationCommands({
  requireOperator,
  prismaClient = prisma,
  inspectCapability = inspectInternationalAuthorizationCapability,
  inspectContext = inspectInternationalAuthorizationContext,
  readSource = collectInternationalAuthorizationSource,
  clock = () => new Date(),
} = {}) {
  if (typeof requireOperator !== "function")
    throw new TypeError("requireOperator required");
  const identity = async (request, purpose) => {
    requirePostRequest(request);
    const primary = await requireOperator(request, {
      role: ROLES.RELEASE_MANAGER,
    });
    assertInternationalShop(primary.session?.shop);
    if (!/^shopify_(user|email):.+$/.test(primary.operator?.actorKey || ""))
      throw authorizationError("international_operator_required", 403);
    if (purpose === "RESUME") {
      const recovery = await requireOperator(request, {
        role: ROLES.RECOVERY_APPROVER,
      });
      if (
        recovery.session?.shop !== primary.session.shop ||
        recovery.operator?.actorKey !== primary.operator.actorKey
      )
        throw authorizationError("international_operator_mismatch", 403);
    }
    return {
      shopDomain: primary.session.shop,
      actorKey: primary.operator.actorKey,
      operatorJson: {
        role: ROLES.RELEASE_MANAGER,
        recovery: purpose === "RESUME",
        accountOwner: primary.operator.accountOwner === true,
      },
    };
  };
  const supported = async () => {
    if (!(await inspectCapability()).ready)
      throw authorizationError(
        "international_verification_not_implemented",
        422,
      );
  };

  return {
    async preview(request, rawInput) {
      const input = normalizeInternationalAuthorization(rawInput);
      const actor = await identity(request, input.purpose);
      await supported();
      const context = await inspectContext({
        prismaClient,
        ...actor,
        input,
        now: clock(),
      });
      assertContext(context, clock());
      const secret = newInternationalSecret();
      const row = await internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          assertContext(context, now);
          const state = await tx.internationalGateSyncState.findUnique({
            where: { shopDomain: actor.shopDomain },
          });
          checkMode(state, input);
          const expiresAt = authorizationExpiry(input, context, now);
          await assertProofs(
            tx,
            actor.shopDomain,
            context.proofReferences,
            now,
            expiresAt,
            effectiveAuthorizationPurpose(input),
          );
          const source = await readSource({
            prismaClient: tx,
            ...actor,
            input,
            context,
            expiresAt,
            now,
          });
          if (!source.ready || !/^[a-f0-9]{64}$/.test(source.sourceHash || ""))
            throw authorizationError("international_scope_ineligible", 422);
          return tx.internationalGateAuthorizationRequest.create({
            data: {
              ...actor,
              purpose: input.purpose,
              resumePurpose: input.resumePurpose,
              verificationKind: input.verificationKind,
              scopeJson: input.scope,
              scopeHash: input.scopeHash,
              currenciesJson: input.currencies,
              requestedExpiresAt: input.requestedExpiresAt,
              effectiveExpiresAt: expiresAt,
              expectedGeneration: state?.desiredGeneration || 0,
              sourceHash: source.sourceHash,
              proofReferencesJson: proofReferences(context.proofReferences),
              nativeConfigHash: context.nativeConfigHash,
              releaseBinding: context.releaseBinding,
              shopTimezone: context.shopTimezone,
              nonceHash: hashInternationalSecret(secret),
              previewExpiresAt: new Date(
                Math.min(now.getTime() + PREVIEW_TTL_MS, expiresAt.getTime()),
              ),
            },
          });
        },
      );
      return {
        ok: true,
        requestId: row.id,
        nonce: secret,
        purpose: input.purpose,
        previewExpiresAt: row.previewExpiresAt,
        effectiveExpiresAt: row.effectiveExpiresAt,
        exclusiveShopDate: internationalLocalDate(
          row.effectiveExpiresAt,
          row.shopTimezone,
        ),
        shopTimezone: row.shopTimezone,
        scopeHash: row.scopeHash,
        pending: false,
      };
    },

    async confirm(request, input) {
      if (
        !input ||
        Object.keys(input).some(
          (key) => !["requestId", "nonce"].includes(key),
        ) ||
        typeof input.requestId !== "string" ||
        input.requestId.length > 128
      )
        throw authorizationError(
          "international_authorization_input_invalid",
          422,
        );
      const actor = await identity(request);
      const row =
        await prismaClient.internationalGateAuthorizationRequest.findFirst({
          where: {
            id: input.requestId,
            shopDomain: actor.shopDomain,
            actorKey: actor.actorKey,
          },
        });
      if (!row || !matchesInternationalSecret(input.nonce, row.nonceHash))
        throw authorizationError("international_authorization_not_found", 403);
      const confirmedActor = await identity(request, row.purpose);
      if (
        confirmedActor.actorKey !== actor.actorKey ||
        confirmedActor.shopDomain !== actor.shopDomain
      )
        throw authorizationError("international_operator_mismatch", 403);
      await supported();
      const normalized = fromRow(row);
      // Replays return history, never re-arm the gate or extend its expiry.
      if (row.consumedAt)
        return {
          ok: true,
          replayed: true,
          requestId: row.id,
          generation: row.consumedGeneration,
          historical: true,
        };
      const context = await inspectContext({
        prismaClient,
        ...actor,
        input: normalized,
        now: clock(),
      });
      assertContext(context, clock());
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const current =
            await tx.internationalGateAuthorizationRequest.findUnique({
              where: { id: row.id },
            });
          if (
            !current ||
            current.shopDomain !== actor.shopDomain ||
            current.actorKey !== actor.actorKey ||
            current.nonceHash !== row.nonceHash ||
            current.scopeHash !== row.scopeHash ||
            internationalHash(fromRow(current)) !==
              internationalHash(normalized)
          )
            throw authorizationError("international_authorization_changed");
          if (
            current.revokedAt ||
            current.previewExpiresAt <= now ||
            current.effectiveExpiresAt <= now
          )
            throw authorizationError("international_authorization_expired");
          if (current.consumedAt)
            return {
              ok: true,
              replayed: true,
              requestId: current.id,
              generation: current.consumedGeneration,
              historical: true,
            };
          assertContext(context, now);
          if (
            context.nativeConfigHash !== current.nativeConfigHash ||
            context.releaseBinding !== current.releaseBinding ||
            context.shopTimezone !== current.shopTimezone ||
            internationalHash(proofReferences(context.proofReferences)) !==
              internationalHash(current.proofReferencesJson) ||
            authorizationExpiry(normalized, context, now) <
              current.effectiveExpiresAt
          )
            throw authorizationError("international_authorization_changed");
          await assertProofs(
            tx,
            actor.shopDomain,
            current.proofReferencesJson,
            now,
            current.effectiveExpiresAt,
            effectiveAuthorizationPurpose(current),
          );
          const state = await tx.internationalGateSyncState.upsert({
            where: { shopDomain: actor.shopDomain },
            create: { shopDomain: actor.shopDomain },
            update: {},
          });
          checkMode(state, normalized);
          if (state.desiredGeneration !== current.expectedGeneration)
            throw authorizationError("international_authorization_changed");
          const source = await readSource({
            prismaClient: tx,
            ...actor,
            input: normalized,
            context,
            expiresAt: current.effectiveExpiresAt,
            now,
          });
          if (!source.ready || source.sourceHash !== current.sourceHash)
            throw authorizationError("international_source_changed");
          if (
            await tx.internationalCheckoutVerificationRun.findFirst({
              where: { activeKey: `${actor.shopDomain}:VERIFY` },
            })
          )
            throw authorizationError("international_run_still_active");
          const [{ now: checkedAt }] =
            await tx.$queryRaw`SELECT clock_timestamp() AS now`;
          assertContext(context, new Date(checkedAt));
          if (
            current.previewExpiresAt <= checkedAt ||
            current.effectiveExpiresAt <= checkedAt
          )
            throw authorizationError("international_authorization_expired");
          const consumed =
            await tx.internationalGateAuthorizationRequest.updateMany({
              where: {
                id: row.id,
                consumedAt: null,
                revokedAt: null,
                previewExpiresAt: { gt: now },
              },
              data: {
                consumedAt: now,
                consumedGeneration: state.desiredGeneration + 1,
                resultCode: "ACCEPTED",
              },
            });
          if (consumed.count !== 1)
            throw authorizationError("international_authorization_changed");
          const purpose = effectiveAuthorizationPurpose(current);
          let run = null;
          if (purpose === "VERIFY")
            run = await tx.internationalCheckoutVerificationRun.create({
              data: {
                shopDomain: actor.shopDomain,
                kind: current.verificationKind,
                authorizationRequestId: row.id,
                initiatedBy: actor.actorKey,
                scenarioVersion: context.scenarioVersion,
                verifierVersion: context.verifierVersion,
                scopeHash: current.scopeHash,
                releaseBinding: current.releaseBinding,
                nativeConfigHash: current.nativeConfigHash,
                proofReferencesJson: current.proofReferencesJson,
                requiredCasesHash: context.requiredCasesHash,
                startGeneration: state.desiredGeneration + 1,
                activeKey: `${actor.shopDomain}:VERIFY`,
                expiresAt: current.effectiveExpiresAt,
              },
            });
          await tx.internationalGateSyncState.update({
            where: { shopDomain: actor.shopDomain },
            data: {
              mode: "ENFORCE",
              authorizationRequestId: row.id,
              authorizationPurpose: purpose,
              verificationRunId: run?.id || null,
              authorizedScopeJson: current.scopeJson,
              authorizedScopeHash: current.scopeHash,
              nativeConfigHash: current.nativeConfigHash,
              releaseBinding: current.releaseBinding,
              shopTimezone: current.shopTimezone,
              authorizationExpiresAt: current.effectiveExpiresAt,
              stopReasonCode: null,
              stoppedAt: null,
            },
          });
          await invalidateInternationalGates(tx, {
            shopDomain: actor.shopDomain,
            now,
          });
          return {
            ok: true,
            pending: true,
            requestId: row.id,
            generation: state.desiredGeneration + 1,
          };
        },
      );
    },
  };
}
