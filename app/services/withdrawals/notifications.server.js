import prisma from "../../db.server.js";
import { buildWithdrawalCompletionSnapshot, buildWithdrawalStatusSnapshot } from "../withdrawalEmailTemplates.js";
import { buildPlainAndHtmlEmail, ensureWithdrawalReturnProofToken, formatDateTime, getWithdrawalOrderName, getWithdrawalSupportEmail, normalizeText, sendWithdrawalEmail } from "./common.js";
export async function sendWithdrawalStatusEmail({
  withdrawalRequestId,
  emailType = "status_update",
  prismaClient = prisma
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      error: "withdrawal_request_not_found"
    };
  }
  const email = buildStatusEmail(withdrawalRequest);
  return sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html
  });
}
export async function sendWithdrawalReturnInstructionsEmail({
  withdrawalRequestId,
  request = null,
  prismaClient = prisma
} = {}) {
  const tokenResult = await ensureWithdrawalReturnProofToken({
    withdrawalRequestId,
    request,
    prismaClient
  });
  if (!tokenResult.ok) {
    return tokenResult;
  }
  const email = buildReturnInstructionsEmail({
    withdrawalRequest: tokenResult.withdrawalRequest,
    returnProofUrl: tokenResult.url,
    expiresAt: tokenResult.expiresAt
  });
  return sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest: tokenResult.withdrawalRequest,
    emailType: "return_instructions",
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html
  });
}
export async function sendWithdrawalCompletionEmail({
  withdrawalRequestId,
  prismaClient = prisma
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      error: "withdrawal_request_not_found"
    };
  }
  if (!withdrawalRequest.completedAt) {
    return {
      ok: false,
      error: "withdrawal_request_not_completed"
    };
  }
  const email = buildCompletionEmail(withdrawalRequest);
  const result = await sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType: "completion",
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html
  });
  if (!result.ok) {
    return result;
  }
  await prismaClient.withdrawalRequest.update({
    where: {
      id: withdrawalRequest.id
    },
    data: {
      completionNotifiedAt: result.sentAt,
      completionEmailMessageId: result.providerMessageId
    }
  });
  return result;
}
function buildReturnInstructionsEmail(options) {
  return buildReturnInstructionsEmailV3(options);
}
function getWithdrawalReturnAddressLines() {
  const raw = normalizeText(process.env.WITHDRAWAL_RETURN_ADDRESS);
  if (!raw) {
    return [];
  }
  return raw.replace(/\\n/g, "\n").split(/\r?\n/).map(line => normalizeText(line, 180)).filter(Boolean);
}
function buildReturnInstructionsEmailV3({
  withdrawalRequest,
  returnProofUrl,
  expiresAt
}) {
  const supportEmail = getWithdrawalSupportEmail();
  const returnAddressLines = getWithdrawalReturnAddressLines();
  const bodyLines = [`${withdrawalRequest.customerName || "お客様"} 様`, "", "撤回申請の確認を進めるため、商品を返送し、返送証明を提出してください。", "", `返送証明の提出リンク: ${returnProofUrl}`, `受付番号: ${withdrawalRequest.id}`, `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`, `リンク有効期限: ${formatDateTime(expiresAt)}`, "", returnAddressLines.length > 0 ? "返送先:" : "返送先は別途ご案内します。", ...returnAddressLines, "", "返送証明の提出だけでは返金は自動実行されません。商品の到着と状態を確認してから処理します。", "撤回が認められる場合、通常配送方法に相当する初回送料を返金対象として確認します。追加配送費用や返送送料は、お客様負担となる場合があります。", supportEmail ? `お問い合わせ: ${supportEmail}` : ""].filter(line => line !== "");
  return buildPlainAndHtmlEmail({
    subject: "返送方法のご案内",
    bodyLines
  });
}
function buildCompletionEmail(withdrawalRequest) {
  return buildWithdrawalCompletionSnapshot(withdrawalRequest);
}
function buildStatusEmail(withdrawalRequest) {
  return buildWithdrawalStatusSnapshot(withdrawalRequest);
}
