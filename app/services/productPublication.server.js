import prisma from "../db.server.js";
import { syncVendorCollectionByStoreId } from "../utils/vendorCollections.server.js";
import {
  evaluateProductGovernanceReadiness,
  evaluateSellerGovernanceReadiness,
  getSellerAgreementReadinessOptions,
  isMarketplaceGovernanceGateEnabled,
} from "./marketplaceGovernance.server.js";

export class ProductPublicationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProductPublicationError";
    this.details = details;
  }
}

export function getVendorCollectionPublicationIssue(collectionSync) {
  if (!collectionSync?.ok) {
    return {
      reason: collectionSync?.reason || "collection_sync_failed",
      details: collectionSync || null,
    };
  }

  if (collectionSync.publish && !collectionSync.publish.ok) {
    return {
      reason: collectionSync.publish.reason || "collection_publish_failed",
      details: collectionSync.publish,
    };
  }

  if (collectionSync.productPublish && !collectionSync.productPublish.ok) {
    return {
      reason: collectionSync.productPublish.reason || "product_publish_failed",
      details: collectionSync.productPublish,
    };
  }

  return null;
}

export async function ensureApprovedProductPublished(
  productId,
  {
    prismaClient = prisma,
    syncVendorCollectionByStoreIdImpl = syncVendorCollectionByStoreId,
    env = process.env,
  } = {},
) {
  const product = await prismaClient.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      approvalStatus: true,
      shopifyProductId: true,
      shopDomain: true,
      vendorStoreId: true,
      complianceProfile: true,
      vendorStore: {
        include: {
          returnAddresses: true,
          seller: {
            include: {
              complianceProfile: true,
              agreementAcceptances: true,
              settlementControl: true,
            },
          },
          vendorAuth: {
            include: {
              seller: {
                include: {
                  complianceProfile: true,
                  agreementAcceptances: true,
                  settlementControl: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!product) {
    throw new ProductPublicationError("Product not found", {
      reason: "product_not_found",
      productId,
    });
  }

  if (product.approvalStatus !== "approved") {
    throw new ProductPublicationError("Product is not approved", {
      reason: "product_not_approved",
      productId,
      approvalStatus: product.approvalStatus,
    });
  }

  if (!product.shopifyProductId) {
    throw new ProductPublicationError("Product is not linked to Shopify", {
      reason: "missing_shopify_product_id",
      productId,
    });
  }

  if (!product.vendorStoreId) {
    throw new ProductPublicationError("Product is not linked to a vendor store", {
      reason: "missing_vendor_store_id",
      productId,
    });
  }

  if (isMarketplaceGovernanceGateEnabled(env)) {
    const seller =
      product.vendorStore?.seller || product.vendorStore?.vendorAuth?.seller || null;
    const sellerForEvaluation = seller
      ? {
          ...seller,
          vendorStore: product.vendorStore,
        }
      : null;
    const sellerReadiness = evaluateSellerGovernanceReadiness(
      sellerForEvaluation,
      getSellerAgreementReadinessOptions(env),
    );
    const productReadiness = evaluateProductGovernanceReadiness(product);

    if (!sellerReadiness.ready || !productReadiness.ready) {
      throw new ProductPublicationError(
        "Marketplace governance requirements are incomplete",
        {
          reason: "marketplace_governance_incomplete",
          productId,
          sellerReasons: sellerReadiness.reasons,
          productReasons: productReadiness.reasons,
        },
      );
    }
  }

  const collectionSync = await syncVendorCollectionByStoreIdImpl(
    product.vendorStoreId,
    {
      shopDomain: product.shopDomain,
    },
  );
  const publicationIssue = getVendorCollectionPublicationIssue(collectionSync);

  if (publicationIssue) {
    throw new ProductPublicationError("Product publication sync failed", {
      ...publicationIssue,
      productId,
      vendorStoreId: product.vendorStoreId,
      collectionSync,
    });
  }

  return {
    ok: true,
    productId,
    vendorStoreId: product.vendorStoreId,
    shopDomain: collectionSync.shopDomain || product.shopDomain,
    shopifyProductId: product.shopifyProductId,
    collectionSync,
  };
}
