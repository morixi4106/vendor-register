import prisma from "../../../db.server.js";
import { createPayoutRunStatusLabel, serializePayoutRecipientSummary, serializeStripeAccountSummary } from "../shared.server.js";
function createPayoutTransferMethodLabel(method) {
  switch (method) {
    case "manual_bank_transfer":
      return "手動精算";
    case "wise_api":
      return "Wise API送金";
    case "stripe_connect_payout":
      return "Stripe Connect payout (legacy)";
    default:
      return method || "-";
  }
}
export async function listPayoutRuns({
  prismaClient = prisma
} = {}) {
  const runs = await prismaClient.payoutRun.findMany({
    orderBy: [{
      createdAt: "desc"
    }],
    include: {
      seller: {
        include: {
          vendor: {
            include: {
              vendorStore: true
            }
          }
        }
      }
    }
  });
  return runs.map(run => ({
    ...run,
    statusLabel: createPayoutRunStatusLabel(run.status),
    transferMethodLabel: createPayoutTransferMethodLabel(run.transferMethod),
    sellerStoreName: run.seller?.vendor?.storeName || "-",
    sellerIsTestStore: Boolean(run.seller?.vendor?.vendorStore?.isTestStore)
  }));
}
export async function getPayoutRunDetail(payoutRunId, {
  prismaClient = prisma
} = {}) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: {
      id: payoutRunId
    },
    include: {
      seller: {
        include: {
          vendor: {
            include: {
              vendorStore: true
            }
          },
          stripeAccount: true,
          payoutRecipient: true
        }
      },
      sellerPayoutRecipient: true,
      ledgerEntries: {
        orderBy: [{
          occurredAt: "desc"
        }, {
          createdAt: "desc"
        }]
      }
    }
  });
  if (!payoutRun?.seller?.vendor) {
    return null;
  }
  return {
    ...payoutRun,
    statusLabel: createPayoutRunStatusLabel(payoutRun.status),
    transferMethodLabel: createPayoutTransferMethodLabel(payoutRun.transferMethod),
    sellerStoreName: payoutRun.seller.vendor.storeName,
    sellerIsTestStore: Boolean(payoutRun.seller.vendor.vendorStore?.isTestStore),
    stripeAccount: serializeStripeAccountSummary(payoutRun.seller.stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient)
  };
}
