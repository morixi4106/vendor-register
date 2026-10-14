import prisma from "../db.server.js";
import { getMonitorReceiptStatus } from "./monitorNotification.server.js";
import { SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY } from "./operationalHealth.server.js";
import { buildLaunchMonitorStatus } from "./launchMonitorStatus.js";

export async function inspectLaunchMonitorStatus({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  monitorHeartbeat,
  notification,
} = {}) {
  if (monitorHeartbeat === undefined) {
    try {
      monitorHeartbeat = await prismaClient.operationalHeartbeat.findUnique({
        where: { key: "production_integrity_monitor" },
        select: { metadataJson: true },
      });
    } catch {
      monitorHeartbeat = null;
    }
  }
  if (notification === undefined) {
    try {
      notification = await getMonitorReceiptStatus({ prismaClient, env, now });
    } catch {
      notification = { ready: false, status: "UNAVAILABLE" };
    }
  }
  let catalogHeartbeat = null;
  let catalogAvailable = true;
  try {
    catalogHeartbeat = await prismaClient.operationalHeartbeat.findUnique({
      where: { key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY },
      select: { lastSucceededAt: true, lastFailedAt: true },
    });
  } catch {
    catalogAvailable = false;
  }
  return buildLaunchMonitorStatus({
    notification,
    monitorMetadata: monitorHeartbeat?.metadataJson || {},
    catalogHeartbeat,
    catalogAvailable,
    env,
    now,
  });
}
