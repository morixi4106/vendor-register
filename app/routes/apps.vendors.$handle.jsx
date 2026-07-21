import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";
import VendorStorefrontPage from "./vendor.$handle.jsx";
import {
  createVendorStorefrontAction,
  createVendorStorefrontLoader,
} from "../services/vendorStorefront.server.js";

const storefrontLoader = createVendorStorefrontLoader();
const storefrontAction = createVendorStorefrontAction();

async function authenticateAppProxy(request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return session.shop;
}

async function resolveCanonicalHandle(handleOrStoreId) {
  const value = String(handleOrStoreId || "").trim();
  if (!value) return null;

  const vendor = await prisma.vendor.findUnique({
    where: { handle: value },
    select: { handle: true, status: true },
  });
  if (vendor?.status === "active") return vendor.handle;

  const store = await prisma.vendorStore.findUnique({
    where: { id: value },
    select: {
      vendorAuth: { select: { handle: true, status: true } },
    },
  });

  return store?.vendorAuth?.status === "active"
    ? store.vendorAuth.handle
    : null;
}

async function withCanonicalHandle(args, handler) {
  await authenticateAppProxy(args.request);
  const handle = await resolveCanonicalHandle(args.params.handle);
  if (!handle) throw new Response("Not Found", { status: 404 });

  return handler({
    ...args,
    params: { ...args.params, handle },
  });
}

export function loader(args) {
  return withCanonicalHandle(args, storefrontLoader);
}

export function action(args) {
  return withCanonicalHandle(args, storefrontAction);
}

export default VendorStorefrontPage;
