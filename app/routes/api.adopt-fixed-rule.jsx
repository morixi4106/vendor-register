import { json } from "@remix-run/node";
import prisma from "../db.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const candidateId = String(body?.candidateId || "").trim();

    if (!candidateId) {
      return json({ ok: false, error: "candidateId is required" }, { status: 400 });
    }

    const candidate = await prisma.fixedReplyCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      return json({ ok: false, error: "Candidate not found" }, { status: 404 });
    }

    await prisma.fixedReplyRule.create({
      data: {
        keyword: candidate.message,
        replyText: candidate.replyText,
        isActive: true,
      },
    });

    return json({ ok: true });
  } catch (error) {
    console.error("adopt fixed rule error:", error);
    return json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
};