import prisma from "../db.server.js";
import { withInternationalGateInvalidation } from "../services/internationalGateQueue.server.js";
import {
  buildProductCountryPolicyData,
  shouldPersistProductCountryPolicy,
} from "./productCountryPolicy.js";

export async function saveProductCountryPolicy({
  productId,
  productEuStatus,
  policyInput,
  prismaClient = prisma,
}) {
  if (!productId) {
    throw new Error("PRODUCT_ID_REQUIRED");
  }
  return withInternationalGateInvalidation(prismaClient, async (tx) => {
    if (!shouldPersistProductCountryPolicy(productEuStatus, policyInput)) {
      await tx.productCountryPolicy.deleteMany({
        where: { productId },
      });

      return null;
    }

    const data = buildProductCountryPolicyData(productEuStatus, policyInput);

    return tx.productCountryPolicy.upsert({
      where: { productId },
      create: {
        productId,
        ...data,
      },
      update: data,
    });
  });
}
