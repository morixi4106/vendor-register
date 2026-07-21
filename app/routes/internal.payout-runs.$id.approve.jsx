import { json, redirect } from "@remix-run/node";

import { approvePayoutRun } from "../services/sellerPayments.server.js";
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

export const action = async ({ request, params }) => {
  const { operator } = await requireMarketplaceOperator(request, {
    role: MARKETPLACE_OPERATOR_ROLES.FINANCE_APPROVER,
  });

  const result = await approvePayoutRun({
    payoutRunId: params.id,
    approvedBy: operator.actorKey,
    approvedByJson: operatorAuditSnapshot(operator),
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        reason: result.reason,
        message: "Failed to approve payout run.",
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
