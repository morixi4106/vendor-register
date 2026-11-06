import prisma from "../db.server.js";
import { requestInternationalGateSync } from "./internationalGateQueue.server.js";
import { runInternationalGateSync } from "./internationalGateSync.server.js";

export const INTERNATIONAL_SALE_GATE_KEY = "international_sale_gate";
export const INTERNATIONAL_SALE_GATE_VERSION = 2;

// This command queues work; it never arms synchronization or expands its ceiling.
export async function syncInternationalSaleGate(
  { shopDomain, prismaClient = prisma, now = new Date() },
  dependencies = {},
) {
  const accepted = await requestInternationalGateSync({
    shopDomain,
    prismaClient,
    now,
  });
  if (!accepted.ok) return accepted;
  const result = await runInternationalGateSync(
    {
      shopDomain,
      prismaClient,
      now,
      maxJobs: 1,
      timeBudgetMs: 8000,
      stopOnly: true,
    },
    dependencies,
  );
  return { ...accepted, protected: result.ok && result.protected === true };
}
