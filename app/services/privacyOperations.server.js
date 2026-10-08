import prisma from "../db.server.js";
import {
  encryptPrivateValue,
  protectVendorManagementEmail,
  protectVendorStoreContact,
  protectContactInquiry,
  readContactInquiry,
} from "../utils/privateData.server.js";

const CHANNEL_KEY = "privacy_contact_channel";
const MAINTENANCE_KEY = "privacy_maintenance";
const LIMIT = 200;

export async function getPrivacyContactChannel({ prismaClient = prisma } = {}) {
  const state = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: CHANNEL_KEY },
  });
  return state?.metadataJson?.provider === "SHOPIFY_INBOX"
    ? "SHOPIFY_INBOX"
    : "LEGACY";
}

export async function recordPrivacyContactChannel(
  { provider, actor, inboxVerified = false, contactPageVerified = false },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!["LEGACY", "SHOPIFY_INBOX"].includes(provider))
    return { ok: false, reason: "invalid_contact_provider" };
  if (provider === "SHOPIFY_INBOX" && (!inboxVerified || !contactPageVerified))
    return { ok: false, reason: "contact_handoff_not_verified" };
  await prismaClient.operationalHeartbeat.upsert({
    where: { key: CHANNEL_KEY },
    create: {
      key: CHANNEL_KEY,
      lastStartedAt: now,
      lastSucceededAt: now,
      metadataJson: {
        provider,
        changedBy: actor,
        changedAt: now.toISOString(),
      },
    },
    update: {
      lastSucceededAt: now,
      metadataJson: {
        provider,
        changedBy: actor,
        changedAt: now.toISOString(),
      },
    },
  });
  return { ok: true };
}

export async function getPrivacyInventory({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const cutoff = new Date(now.getTime() - 90 * 86400_000);
  const [
    stores,
    vendors,
    orders,
    inquiries,
    expiredCodes,
    expiredSessions,
    resolvedInquiries,
    sessions,
  ] = await Promise.all([
    prismaClient.vendorStore.count({ where: { emailLookupHash: null } }),
    prismaClient.vendor.count({ where: { managementEmailLookupHash: null } }),
    prismaClient.marketplaceOrder.count({
      where: {
        OR: [
          {
            buyerEmail: { not: null },
            NOT: { buyerEmail: { startsWith: "private:v1:" } },
          },
          {
            buyerName: { not: null },
            NOT: { buyerName: { startsWith: "private:v1:" } },
          },
        ],
      },
    }),
    prismaClient.contactInquiry.count(),
    prismaClient.vendorLoginCode.count({ where: { expiresAt: { lt: now } } }),
    prismaClient.vendorAdminSession.count({
      where: { expiresAt: { lt: now } },
    }),
    prismaClient.contactInquiry.count({
      where: {
        status: "RESOLVED",
        retentionHold: false,
        resolvedAt: { lt: cutoff },
      },
    }),
    prismaClient.session.count({
      where: { accessToken: { not: { startsWith: "private:v1:" } } },
    }),
  ]);
  return {
    legacyStoreContacts: stores,
    legacyVendorEmails: vendors,
    legacyOrderContactCopies: orders,
    inquiries,
    expiredCodes,
    expiredSessions,
    resolvedInquiryCandidates: resolvedInquiries,
    legacyShopifyTokens: sessions,
  };
}

export async function protectLegacyVendorContacts({
  prismaClient = prisma,
  env = process.env,
  limit = LIMIT,
} = {}) {
  const take = Math.min(LIMIT, Math.max(1, Number(limit) || LIMIT));
  const stores = await prismaClient.vendorStore.findMany({
    where: { emailLookupHash: null },
    take,
    orderBy: { id: "asc" },
  });
  const vendors = await prismaClient.vendor.findMany({
    where: { managementEmailLookupHash: null },
    take,
    orderBy: { id: "asc" },
  });
  const sessions = await prismaClient.session.findMany({
    where: { accessToken: { not: { startsWith: "private:v1:" } } },
    take,
    orderBy: { id: "asc" },
  });
  const inquiries = await prismaClient.contactInquiry.findMany({
    where: { emailLookupHash: null },
    take,
    orderBy: { id: "asc" },
  });
  const orders = await prismaClient.marketplaceOrder.findMany({
    where: {
      OR: [
        {
          buyerEmail: { not: null },
          NOT: { buyerEmail: { startsWith: "private:v1:" } },
        },
        {
          buyerName: { not: null },
          NOT: { buyerName: { startsWith: "private:v1:" } },
        },
      ],
    },
    take,
    orderBy: { id: "asc" },
  });
  const counts = {
    protectedStores: 0,
    protectedVendors: 0,
    protectedShopifyTokens: 0,
    protectedInquiries: 0,
    protectedOrderContacts: 0,
  };
  await prismaClient.$transaction(
    async (tx) => {
      for (const store of stores)
        counts.protectedStores += (
          await tx.vendorStore.updateMany({
            where: {
              id: store.id,
              emailLookupHash: null,
              updatedAt: store.updatedAt,
            },
            data: protectVendorStoreContact(
              {
                ownerName: store.ownerName,
                email: store.email,
                phone: store.phone,
                address: store.address,
                note: store.note,
              },
              { env },
            ),
          })
        ).count;
      for (const vendor of vendors)
        counts.protectedVendors += (
          await tx.vendor.updateMany({
            where: {
              id: vendor.id,
              managementEmailLookupHash: null,
              updatedAt: vendor.updatedAt,
            },
            data: protectVendorManagementEmail(vendor.managementEmail, { env }),
          })
        ).count;
      for (const session of sessions)
        counts.protectedShopifyTokens += (
          await tx.session.updateMany({
            where: { id: session.id, accessToken: session.accessToken },
            data: {
              accessToken: encryptPrivateValue(session.accessToken, { env }),
              refreshToken: encryptPrivateValue(session.refreshToken, { env }),
            },
          })
        ).count;
      for (const inquiry of inquiries)
        counts.protectedInquiries += (
          await tx.contactInquiry.updateMany({
            where: {
              id: inquiry.id,
              emailLookupHash: null,
              email: inquiry.email,
              message: inquiry.message,
            },
            data: protectContactInquiry(
              {
                name: inquiry.name,
                email: inquiry.email,
                phone: inquiry.phone,
                message: inquiry.message,
                replyText: inquiry.replyText,
              },
              { env },
            ),
          })
        ).count;
      for (const order of orders)
        counts.protectedOrderContacts += (
          await tx.marketplaceOrder.updateMany({
            where: {
              id: order.id,
              buyerEmail: order.buyerEmail,
              buyerName: order.buyerName,
            },
            data: {
              buyerEmail: order.buyerEmail?.startsWith("private:v1:")
                ? order.buyerEmail
                : encryptPrivateValue(order.buyerEmail, { env }),
              buyerName: order.buyerName?.startsWith("private:v1:")
                ? order.buyerName
                : encryptPrivateValue(order.buyerName, { env }),
            },
          })
        ).count;
    },
    { isolationLevel: "Serializable", maxWait: 5000, timeout: 30000 },
  );
  return counts;
}

export async function revokeAllVendorSessions({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  return prismaClient.vendorAdminSession.updateMany({
    where: { expiresAt: { gt: now } },
    data: { expiresAt: now },
  });
}

export async function runPrivacyMaintenance({
  prismaClient = prisma,
  now = new Date(),
  pruneResolvedInquiries = false,
} = {}) {
  return prismaClient.$transaction(
    async (tx) => {
      const heartbeat = await tx.operationalHeartbeat.findUnique({
        where: { key: MAINTENANCE_KEY },
      });
      if (
        !pruneResolvedInquiries &&
        heartbeat?.lastSucceededAt &&
        now - new Date(heartbeat.lastSucceededAt) < 23 * 60 * 60_000
      )
        return { ok: true, skipped: true };
      const cutoff = now;
      const codes = await tx.vendorLoginCode.findMany({
        where: { expiresAt: { lt: cutoff } },
        select: { id: true },
        take: LIMIT,
      });
      const sessions = await tx.vendorAdminSession.findMany({
        where: { expiresAt: { lt: cutoff } },
        select: { id: true },
        take: LIMIT,
      });
      const codeDeletion = await tx.vendorLoginCode.deleteMany({
        where: {
          id: { in: codes.map((row) => row.id) },
          expiresAt: { lt: cutoff },
        },
      });
      const sessionDeletion = await tx.vendorAdminSession.deleteMany({
        where: {
          id: { in: sessions.map((row) => row.id) },
          expiresAt: { lt: cutoff },
        },
      });
      let deletedInquiries = 0;
      if (pruneResolvedInquiries) {
        const inquiryCutoff = new Date(now.getTime() - 90 * 86400_000);
        const candidates = await tx.contactInquiry.findMany({
          where: {
            status: "RESOLVED",
            resolvedAt: { lt: inquiryCutoff },
            retentionHold: false,
          },
          select: { id: true },
          take: LIMIT,
        });
        const result = await tx.contactInquiry.deleteMany({
          where: {
            id: { in: candidates.map((row) => row.id) },
            status: "RESOLVED",
            retentionHold: false,
            resolvedAt: { lt: inquiryCutoff },
          },
        });
        deletedInquiries = result.count;
      }
      const counts = {
        deletedCodes: codeDeletion.count,
        deletedSessions: sessionDeletion.count,
        deletedInquiries,
      };
      await tx.operationalHeartbeat.upsert({
        where: { key: MAINTENANCE_KEY },
        create: {
          key: MAINTENANCE_KEY,
          lastStartedAt: now,
          lastSucceededAt: now,
          metadataJson: counts,
        },
        update: { lastSucceededAt: now, metadataJson: counts },
      });
      return { ok: true, ...counts };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function listPrivateContactInquiries({
  replyType = "",
  query = "",
  prismaClient = prisma,
  env = process.env,
} = {}) {
  const rows = await prismaClient.contactInquiry.findMany({
    where: ["fixed", "ai", "escalation"].includes(replyType)
      ? { replyType }
      : {},
    orderBy: { createdAt: "desc" },
    take: query.trim() ? 1000 : 100,
  });
  const q = query.trim().toLowerCase();
  return rows
    .map((row) => readContactInquiry(row, { env }))
    .filter(
      (row) =>
        !q ||
        [row.name, row.email, row.phone, row.message, row.replyText].some(
          (field) =>
            String(field || "")
              .toLowerCase()
              .includes(q),
        ),
    )
    .slice(0, 100);
}
