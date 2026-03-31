import { json } from "@remix-run/node";
import prisma from "../db.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ ok: false }, { status: 405 });
  }

  try {
    const body = await request.json();

    const message = String(body?.message || "").trim();
    const replyText = String(body?.replyText || "").trim();

    if (!message || !replyText) {
      return json({ ok: false, error: "invalid" }, { status: 400 });
    }

    await prisma.fixedReplyCandidate.create({
      data: {
        message,
        replyText,
      },
    });

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false }, { status: 500 });
  }
};