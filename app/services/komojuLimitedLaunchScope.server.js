import prisma from "../db.server.js";
import {
  EU_PRODUCT_ALLOWED_STATUSES,
  EU_SELLER_ALLOWED_STATUSES,
} from "../utils/deliveryEligibility.js";
import { isThirdPartyCommerceDisabled } from "../utils/singleOperatorReadiness.js";

export async function inspectKomojuLimitedLaunchScope({
  prismaClient = prisma,
  env = process.env,
} = {}) {
  const [
    euEnabledSellerCount,
    euEnabledProductCount,
    internationalEnabledProductCount,
  ] = await Promise.all([
    prismaClient.seller.count({
      where: {
        euSellerStatus: { in: Array.from(EU_SELLER_ALLOWED_STATUSES) },
        vendorStore: { is: { isTestStore: false } },
      },
    }),
    prismaClient.product.count({
      where: {
        OR: [
          { euSaleRequested: true },
          {
            productEuStatus: {
              in: Array.from(EU_PRODUCT_ALLOWED_STATUSES),
            },
          },
        ],
        vendorStore: { is: { isTestStore: false } },
      },
    }),
    prismaClient.product.count({
      where: {
        approvalStatus: "approved",
        internationalShippingMethod: "AIR_PACKET",
        vendorStore: {
          is: {
            isPlatformStore: true,
            isTestStore: false,
          },
        },
      },
    }),
  ]);
  const thirdPartyCommerceDisabled = isThirdPartyCommerceDisabled(env);
  return {
    ready:
      thirdPartyCommerceDisabled &&
      euEnabledSellerCount === 0 &&
      euEnabledProductCount === 0 &&
      internationalEnabledProductCount === 0,
    thirdPartyCommerceDisabled,
    euEnabledSellerCount,
    euEnabledProductCount,
    internationalEnabledProductCount,
  };
}
