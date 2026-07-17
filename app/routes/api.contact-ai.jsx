import crypto from "node:crypto";

import { json } from "@remix-run/node";
import { Resend } from "resend";

import prisma from "../db.server.js";
import {
  buildAdminContactNotification,
  buildContactAcknowledgement,
} from "../services/contactInquiry.server.js";
import {
  consumePublicEndpointRateLimit,
  getRequestClientIp,
  inspectPublicEndpointRateLimit,
  pruneExpiredPublicEndpointRateLimits,
} from "../services/publicEndpointRateLimit.server.js";

const CONTACT_ENDPOINT = "contact-ai";
const MAX_BODY_BYTES = 20_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GLOBAL_HOURLY_LIMIT = 100;
const GLOBAL_DAILY_LIMIT = 500;

export const loader = async ({ request }) => {
  if (request.method !== "OPTIONS") return new Response("Not Found", { status: 404 });
  const origin = getAllowedOrigin(request);
  if (!origin) return new Response("Forbidden", { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
};

export const action = async ({ request }) => {
  const origin = getAllowedOrigin(request);
  if (!origin) return json({ ok: false, error: "origin_not_allowed" }, { status: 403 });
  const headers = corsHeaders(origin);

  if (request.method !== "POST") {
    return json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...headers, Allow: "POST, OPTIONS" } },
    );
  }
  if (!String(request.headers.get("content-type") || "").includes("application/json")) {
    return json({ ok: false, error: "invalid_content_type" }, { status: 415, headers });
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, { status: 413, headers });
  }

  try {
    const body = await request.json();
    if (String(body?.website || body?.company || "").trim()) {
      return json({ ok: true, accepted: true }, { headers });
    }
    const name = normalizeField(body?.name, 120);
    const email = normalizeField(body?.email, 254).toLowerCase();
    const phone = normalizeField(body?.phone, 40);
    const message = normalizeField(body?.message, 4_000);
    if (!name || !EMAIL_PATTERN.test(email) || !message) {
      return json({ ok: false, error: "invalid_fields" }, { status: 400, headers });
    }
    const submissionKey = crypto
      .createHash("sha256")
      .update(`${email}\n${message}`, "utf8")
      .digest("hex")
      .slice(0, 40);

    const globalHourStatus = await inspectPublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: "global:hour",
      limit: GLOBAL_HOURLY_LIMIT,
      windowMs: 60 * 60 * 1000,
    });
    const globalDayStatus = await inspectPublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: "global:day",
      limit: GLOBAL_DAILY_LIMIT,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!globalHourStatus.ok || !globalDayStatus.ok) {
      const retryAfter = Math.max(
        globalHourStatus.ok ? 0 : globalHourStatus.retryAfterSeconds,
        globalDayStatus.ok ? 0 : globalDayStatus.retryAfterSeconds,
      );
      return json(
        { ok: false, error: "temporarily_unavailable" },
        { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } },
      );
    }

    const ipLimit = await consumePublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: `ip:${getRequestClientIp(request)}`,
      limit: 5,
      windowMs: 10 * 60 * 1000,
    });
    const emailLimit = await consumePublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: `email:${email}`,
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!ipLimit.ok || !emailLimit.ok) {
      const retryAfter = Math.max(
        ipLimit.ok ? 0 : ipLimit.retryAfterSeconds,
        emailLimit.ok ? 0 : emailLimit.retryAfterSeconds,
      );
      return json(
        { ok: false, error: "rate_limited" },
        { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } },
      );
    }

    const globalHourLimit = await consumePublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: "global:hour",
      limit: GLOBAL_HOURLY_LIMIT,
      windowMs: 60 * 60 * 1000,
    });
    const globalDayLimit = await consumePublicEndpointRateLimit({
      endpoint: CONTACT_ENDPOINT,
      key: "global:day",
      limit: GLOBAL_DAILY_LIMIT,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!globalHourLimit.ok || !globalDayLimit.ok) {
      const retryAfter = Math.max(
        globalHourLimit.ok ? 0 : globalHourLimit.retryAfterSeconds,
        globalDayLimit.ok ? 0 : globalDayLimit.retryAfterSeconds,
      );
      console.warn("contact inquiry global rate limit reached", {
        hourlyCount: globalHourLimit.count,
        dailyCount: globalDayLimit.count,
      });
      return json(
        { ok: false, error: "temporarily_unavailable" },
        { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } },
      );
    }

    try {
      await pruneExpiredPublicEndpointRateLimits();
    } catch (error) {
      console.warn("expired public rate limit cleanup failed", error);
    }

    ensureEmailConfiguration();
    const replyType = "fixed";
    const replyText = buildContactAcknowledgement({ name });

    await prisma.contactInquiry.create({
      data: {
        name,
        email,
        phone: phone || null,
        message,
        replyText,
        replyType,
        matchedRuleId: null,
      },
    });
    const resend = new Resend(process.env.RESEND_API_KEY);
    const buyerResult = await resend.emails.send(
      {
        from: process.env.MAIL_FROM,
        to: email,
        subject: "お問い合わせを受け付けました",
        text: replyText,
      },
      { idempotencyKey: `contact-buyer-${submissionKey}` },
    );
    if (buyerResult?.error) throw new Error(buyerResult.error.message || "buyer_email_failed");
    const adminResult = await resend.emails.send(
      {
        from: process.env.MAIL_FROM,
        to: process.env.ADMIN_EMAIL,
        subject: "新しいお問い合わせ",
        text: buildAdminContactNotification({
          name,
          email,
          phone,
          message,
          replyText,
        }),
      },
      { idempotencyKey: `contact-admin-${submissionKey}` },
    );
    if (adminResult?.error) throw new Error(adminResult.error.message || "admin_email_failed");

    return json(
      { ok: true, replyType, matchedRuleId: null },
      { headers },
    );
  } catch (error) {
    console.error("api.contact-ai error:", error);
    return json({ ok: false, error: "internal_server_error" }, { status: 500, headers });
  }
};

function normalizeField(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function getAllowedOrigin(request) {
  const requestOrigin = String(request.headers.get("origin") || "").trim();
  if (!requestOrigin) return null;
  return allowedOrigins().has(normalizeOrigin(requestOrigin))
    ? normalizeOrigin(requestOrigin)
    : null;
}

function allowedOrigins() {
  const configured = [
    process.env.CONTACT_ALLOWED_ORIGINS,
    process.env.WITHDRAWAL_PUBLIC_BASE_URL,
    process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN,
    process.env.SHOPIFY_SHOP,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","));
  return new Set(configured.map(normalizeOrigin).filter(Boolean));
}

function normalizeOrigin(value) {
  const candidate = /^https?:\/\//i.test(String(value || "").trim())
    ? String(value).trim()
    : `https://${String(value || "").trim()}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return "";
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function ensureEmailConfiguration() {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM || !process.env.ADMIN_EMAIL) {
    throw new Error("email_not_configured");
  }
}
