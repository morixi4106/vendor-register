import { json, redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { executePayoutRun } from "../services/sellerPayments.server.js";

export const loader = async () => {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  const result = await executePayoutRun({
    payoutRunId: params.id,
    executedBy: "admin",
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: "Failed to execute payout run.",
      },
      { status: 400 },
    );
  }

  const acceptsJson = request.headers.get("Accept")?.includes("application/json");
  if (acceptsJson) {
    return json(result);
  }

  return redirect(`/app/payout-runs/${params.id}`);
};
