import { createCookie, redirect } from "@remix-run/node";
import prisma from "../../db.server.js";
export const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8
});
export const vendorAdminSessionsCookie = createCookie("vendor_admin_sessions", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8
});
export const vendorRegistrationTargetCookie = createCookie("vendor_registration_target", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 30
});
export function sanitizeVendorReturnTo(value, fallback = "/vendor/dashboard") {
  const returnTo = String(value || "").trim();
  if (!returnTo || returnTo.startsWith("//")) {
    return fallback;
  }
  if (!returnTo.startsWith("/")) {
    return fallback;
  }
  if (returnTo.startsWith("/vendor/verify") || returnTo.startsWith("/apps/vendors/verify")) {
    return fallback;
  }
  return returnTo;
}
export function getVendorReturnTo(request, fallback = "/vendor/dashboard") {
  const url = new URL(request.url);
  return sanitizeVendorReturnTo(url.searchParams.get("returnTo"), fallback);
}
export function appendVendorIdToPath(path, vendorId) {
  const normalizedVendorId = String(vendorId || "").trim();
  const target = String(path || "").trim();
  if (!normalizedVendorId || !target || target.startsWith("//")) {
    return target;
  }
  if (!target.startsWith("/")) {
    return target;
  }
  try {
    const url = new URL(target, "https://vendor.local");
    url.searchParams.set("vendorId", normalizedVendorId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return target;
  }
}
export function getRequestVendorId(request) {
  const url = new URL(request.url);
  return String(url.searchParams.get("vendorId") || "").trim();
}
export function getVendorVerifyRedirectPath(request) {
  const url = new URL(request.url);
  const returnTo = sanitizeVendorReturnTo(`${url.pathname}${url.search}`);
  const vendorId = getRequestVendorId(request);
  const verifyUrl = new URL("/vendor/verify", "https://vendor.local");
  verifyUrl.searchParams.set("returnTo", returnTo);
  if (vendorId) {
    verifyUrl.searchParams.set("vendorId", vendorId);
  }
  return `${verifyUrl.pathname}${verifyUrl.search}`;
}
function normalizeVendorSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions) ? value.sessions : value;
  const entries = Object.entries(source).map(([vendorId, sessionToken]) => [String(vendorId || "").trim(), String(sessionToken || "").trim()]).filter(([vendorId, sessionToken]) => vendorId && sessionToken);
  return Object.fromEntries(entries);
}
async function parseVendorSessionMap(cookieHeader) {
  const value = await vendorAdminSessionsCookie.parse(cookieHeader);
  return normalizeVendorSessionMap(value);
}
export async function createVendorAdminSessionCookieHeaders(request, {
  vendorId,
  sessionToken
}) {
  const cookieHeader = request.headers.get("Cookie");
  const normalizedVendorId = String(vendorId || "").trim();
  const normalizedSessionToken = String(sessionToken || "").trim();
  const sessionMap = await parseVendorSessionMap(cookieHeader);
  if (normalizedVendorId && normalizedSessionToken) {
    sessionMap[normalizedVendorId] = normalizedSessionToken;
  }
  const headers = new Headers();
  headers.append("Set-Cookie", await vendorAdminSessionCookie.serialize(normalizedSessionToken));
  headers.append("Set-Cookie", await vendorAdminSessionsCookie.serialize({
    sessions: sessionMap
  }));
  return headers;
}
export function getConfiguredAdminEmails(env = process.env) {
  return Array.from(new Set([env.ADMIN_EMAIL, env.ADMIN_EMAILS, env.VENDOR_ADMIN_EMAILS].flatMap(value => String(value || "").split(",")).map(value => value.trim().toLowerCase()).filter(Boolean)));
}
export function isConfiguredAdminEmail(email, env = process.env) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return false;
  }
  return getConfiguredAdminEmails(env).includes(normalizedEmail);
}
export async function requireVendorSession(request, {
  includeProducts = false
} = {}) {
  const cookieHeader = request.headers.get("Cookie");
  const requestedVendorId = getRequestVendorId(request);
  const currentSessionToken = await vendorAdminSessionCookie.parse(cookieHeader);
  const sessionMap = requestedVendorId ? await parseVendorSessionMap(cookieHeader) : {};
  const sessionToken = requestedVendorId ? sessionMap[requestedVendorId] || currentSessionToken : currentSessionToken;
  if (!sessionToken) {
    throw redirect(getVendorVerifyRedirectPath(request));
  }
  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: {
      sessionToken
    },
    include: {
      vendor: {
        include: {
          vendorStore: includeProducts ? {
            include: {
              products: {
                include: {
                  countryPolicy: true
                },
                orderBy: {
                  updatedAt: "desc"
                }
              }
            }
          } : true
        }
      }
    }
  });
  if (!vendorSession || vendorSession.expiresAt < new Date() || requestedVendorId && vendorSession.vendorId !== requestedVendorId) {
    throw redirect(getVendorVerifyRedirectPath(request), {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0
        })
      }
    });
  }
  return vendorSession;
}
export async function requireVendorContext(request, options = {}) {
  const vendorSession = await requireVendorSession(request, options);
  const vendor = vendorSession.vendor;
  const store = vendor?.vendorStore;
  if (!vendor || !store) {
    throw new Response("店舗情報が見つかりません。", {
      status: 404
    });
  }
  return {
    vendorSession,
    vendor,
    store
  };
}
