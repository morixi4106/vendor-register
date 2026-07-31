import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";
import {
  createMarketplaceOperatorAuthorizer,
  operatorAuditSnapshot,
} from "./marketplaceOperatorAuthorization.js";

export {
  MARKETPLACE_OPERATOR_ROLES,
  resolveProductionReadinessOperatorRole,
} from "./marketplaceOperatorRoles.js";
export { operatorAuditSnapshot };

export const requireMarketplaceOperator =
  createMarketplaceOperatorAuthorizer({
    authenticateAdminImpl: authenticate.admin,
    defaultPrismaClient: prisma,
  });
