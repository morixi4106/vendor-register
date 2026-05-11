import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { buildVendorCollectionUrl } from "../utils/vendorCollectionHandles";

export async function loader({ params }) {
  const handleOrStoreId = String(params.handle || "").trim();

  if (!handleOrStoreId) {
    throw new Response("Not Found", { status: 404 });
  }

  const vendor = await prisma.vendor.findUnique({
    where: { handle: handleOrStoreId },
    select: { handle: true, status: true },
  });

  if (vendor?.status === "active") {
    const collectionUrl = buildVendorCollectionUrl(vendor.handle);

    if (collectionUrl) {
      throw redirect(collectionUrl);
    }
  }

  const store = await prisma.vendorStore.findUnique({
    where: { id: handleOrStoreId },
    select: {
      vendorAuth: {
        select: {
          handle: true,
          status: true,
        },
      },
    },
  });
  const canonicalHandle = String(store?.vendorAuth?.handle || "").trim();

  if (canonicalHandle && store?.vendorAuth?.status === "active") {
    const collectionUrl = buildVendorCollectionUrl(canonicalHandle);

    if (collectionUrl) {
      throw redirect(collectionUrl);
    }
  }

  throw new Response("Not Found", { status: 404 });
}

export async function action() {
  throw new Response("Not Found", { status: 404 });
}

export default function VendorCollectionRedirectPage() {
  return null;
}
