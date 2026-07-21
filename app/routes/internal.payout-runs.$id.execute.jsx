import { json, redirect } from "@remix-run/node";

import { markPayoutRunManuallyPaid } from "../services/sellerPayments.server.js";
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
    role: MARKETPLACE_OPERATOR_ROLES.FINANCE_EXECUTOR,
  });

  const formData = await request.formData();
  const result = await markPayoutRunManuallyPaid({
    payoutRunId: params.id,
    executedBy: operator.actorKey,
    executedByJson: operatorAuditSnapshot(operator),
    externalTransferId: formData.get("externalTransferId"),
    transferMemo: formData.get("transferMemo"),
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
