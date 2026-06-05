import prisma from "../db.server.js";
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

  if (!shouldPersistProductCountryPolicy(productEuStatus, policyInput)) {
    await prismaClient.productCountryPolicy.deleteMany({
      where: { productId },
    });

    return null;
  }

  const data = buildProductCountryPolicyData(productEuStatus, policyInput);

  return prismaClient.productCountryPolicy.upsert({
    where: { productId },
    create: {
      productId,
      ...data,
    },
    update: data,
  });
}
