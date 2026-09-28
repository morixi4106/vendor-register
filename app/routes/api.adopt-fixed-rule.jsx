
import prisma from "../db.server";
import { requireShopifyAdmin } from "../utils/routeSecurity.server.js";

export const action = async ({ request }) => {
  await requireShopifyAdmin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const candidateId = String(body?.candidateId || "").trim();

    if (!candidateId) {
      return Response.json({ ok: false, error: "candidateId is required" }, { status: 400 });
    }

    const candidate = await prisma.fixedReplyCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      return Response.json({ ok: false, error: "Candidate not found" }, { status: 404 });
    }

    await prisma.fixedReplyRule.create({
      data: {
        keyword: candidate.message,
        replyText: candidate.replyText,
        isActive: true,
      },
    });

    return Response.json({ ok: true });
  } catch (error) {
    console.error("adopt fixed rule error:", error);
    return Response.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
};
