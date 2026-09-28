
import prisma from "../db.server";
import { requireShopifyAdmin } from "../utils/routeSecurity.server.js";

export const action = async ({ request }) => {
  await requireShopifyAdmin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false }, { status: 405 });
  }

  try {
    const body = await request.json();

    const message = String(body?.message || "").trim();
    const replyText = String(body?.replyText || "").trim();

    if (!message || !replyText) {
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }

    await prisma.fixedReplyCandidate.create({
      data: {
        message,
        replyText,
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false }, { status: 500 });
  }
};
