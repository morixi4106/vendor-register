import prisma from "../../db.server.js";
import { WITHDRAWAL_CONTRACT_MODES, text } from "./common.js";
export async function upsertWithdrawalWorkflowPolicy({
  version,
  contractMode,
  termsVersion,
  directReturnEnabled = false,
  notes = null,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  if (!Object.values(WITHDRAWAL_CONTRACT_MODES).includes(contractMode)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_contract_mode"
    };
  }
  if (!Number.isInteger(Number(version)) || Number(version) < 2 || !text(termsVersion)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_policy"
    };
  }
  const policy = await prismaClient.withdrawalWorkflowPolicy.upsert({
    where: {
      version: Number(version)
    },
    create: {
      version: Number(version),
      contractMode,
      termsVersion: text(termsVersion),
      directReturnEnabled: Boolean(directReturnEnabled),
      notes: text(notes) || null
    },
    update: {
      contractMode,
      termsVersion: text(termsVersion),
      directReturnEnabled: Boolean(directReturnEnabled),
      notes: text(notes) || null,
      ...(directReturnEnabled ? {} : {
        active: false,
        deactivatedAt: new Date(),
        deactivatedBy: changedBy
      })
    }
  });
  return {
    ok: true,
    policy
  };
}
export async function activateWithdrawalWorkflowPolicy({
  policyId,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const policy = await prismaClient.withdrawalWorkflowPolicy.findUnique({
    where: {
      id: text(policyId)
    }
  });
  if (!policy || !policy.directReturnEnabled) {
    return {
      ok: false,
      status: 400,
      error: "policy_not_ready"
    };
  }
  const now = new Date();
  await prismaClient.$transaction([prismaClient.withdrawalWorkflowPolicy.updateMany({
    where: {
      active: true,
      id: {
        not: policy.id
      }
    },
    data: {
      active: false,
      deactivatedAt: now,
      deactivatedBy: changedBy
    }
  }), prismaClient.withdrawalWorkflowPolicy.update({
    where: {
      id: policy.id
    },
    data: {
      active: true,
      effectiveAt: policy.effectiveAt || now,
      activatedAt: now,
      activatedBy: changedBy,
      deactivatedAt: null,
      deactivatedBy: null
    }
  })]);
  return {
    ok: true
  };
}
