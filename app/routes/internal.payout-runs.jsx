import { json, redirect } from "@remix-run/node";

import { createPayoutRun } from "../services/sellerPayments.server.js";
import {
  MARKETPLACE_OPERATOR_ROLES,
  operatorAuditSnapshot,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

export const loader = async () => {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
};

export const action = async ({ request }) => {
  const { operator } = await requireMarketplaceOperator(request, {
    role: MARKETPLACE_OPERATOR_ROLES.FINANCE_PREPARER,
  });

  const formData = await request.formData();
  const result = await createPayoutRun({
    sellerId: String(formData.get("sellerId") || ""),
    amount: formData.get("amount"),
    currencyCode: String(formData.get("currencyCode") || "jpy"),
    createdBy: operator.actorKey,
    createdByJson: operatorAuditSnapshot(operator),
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: "Failed to create payout run.",
      },
      { status: 400 },
    );
  }

  const acceptsJson = request.headers.get("Accept")?.includes("application/json");
  if (acceptsJson) {
    return json(result);
  }

  return redirect(`/app/payout-runs/${result.payoutRun.id}`);
};
