import { authenticate } from "../shopify.server.js";

export {
  readBearerToken,
  requireBearerToken,
  requirePostRequest,
  secureStringEqual,
} from "./internalRouteSecurity.server.js";

export async function requireShopifyAdmin(request) {
  return authenticate.admin(request);
}
