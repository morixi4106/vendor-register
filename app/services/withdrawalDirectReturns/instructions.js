import crypto from "node:crypto";
import prisma from "../../db.server.js";
import { addDays, addressSnapshot, hashToken, jsonArray, jsonObject, recomputeWithdrawalV2State, text } from "./common.js";
const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 45;
function serializeRequestedLine(line) {
  return {
    requestedLineId: line.requestedLine.id,
    shopifyLineItemId: line.requestedLine.shopifyLineItemId,
    title: line.requestedLine.titleSnapshot,
    sku: line.requestedLine.skuSnapshot,
    quantity: line.instructedQuantity,
    returnDisposition: line.requestedLine.returnDisposition,
    currencyCode: line.requestedLine.currencyCode
  };
}
export async function createReturnInstruction({
  returnGroupId,
  operationalReturnDeadlineAt,
  notes = null,
  changedBy = "admin",
  send = false,
  request = null,
  sendEmailImpl = null,
  prismaClient = prisma
} = {}) {
  const group = await prismaClient.withdrawalReturnGroup.findUnique({
    where: {
      id: text(returnGroupId)
    },
    include: {
      withdrawalRequest: true,
      vendorStore: {
        include: {
          vendorAuth: true
        }
      },
      returnAddress: {
        include: {
          locales: true
        }
      },
      lines: {
        include: {
          requestedLine: true
        }
      },
      instructions: {
        orderBy: {
          version: "desc"
        },
        take: 1
      }
    }
  });
  if (!group) return {
    ok: false,
    status: 404,
    error: "return_group_not_found"
  };
  if (!['APPROVED', 'RETURN_REQUESTED'].includes(group.withdrawalRequest.status)) {
    return {
      ok: false,
      status: 409,
      error: "withdrawal_approval_required"
    };
  }
  if (!group.returnAddress || group.returnAddress.status !== "ACTIVE") {
    return {
      ok: false,
      status: 409,
      error: "active_return_address_required"
    };
  }
  if (group.mappingStatus !== "CONFIRMED" || !group.lines.length) {
    return {
      ok: false,
      status: 409,
      error: "line_mapping_required"
    };
  }
  if (group.instructionsSentAt && group.instructions[0]?.status === "SENT" && !send) {
    return {
      ok: false,
      status: 409,
      error: "instruction_already_sent"
    };
  }
  const deadline = operationalReturnDeadlineAt ? new Date(operationalReturnDeadlineAt) : addDays(new Date(), 14);
  const previous = group.instructions[0] || null;
  const instruction = await prismaClient.withdrawalReturnInstruction.create({
    data: {
      returnGroupId: group.id,
      version: Number(previous?.version || 0) + 1,
      status: "DRAFT",
      storeSnapshotJson: {
        vendorStoreId: group.vendorStoreId,
        storeName: group.storeNameSnapshot,
        sellerLegalRole: group.sellerLegalRoleSnapshot
      },
      addressSnapshotJson: addressSnapshot(group.returnAddress),
      itemsSnapshotJson: group.lines.map(serializeRequestedLine),
      deadlineSnapshotJson: {
        statutoryReturnDeadlineAt: group.statutoryReturnDeadlineAt?.toISOString?.() || null,
        operationalReturnDeadlineAt: deadline.toISOString()
      },
      returnCostSnapshotJson: {
        payer: group.returnShippingPayer
      },
      notesSnapshot: text(notes) || null,
      templateVersion: "direct-return-v2-1",
      sentAt: null,
      sentBy: null,
      supersedesInstructionId: previous?.status === "SENT" ? previous.id : null
    }
  });
  if (send) {
    if (typeof sendEmailImpl !== "function") {
      return {
        ok: false,
        status: 500,
        error: "email_sender_required",
        instruction
      };
    }
    const issued = await issueWithdrawalGroupAccessToken({
      returnGroupId: group.id,
      purpose: "RETURN_PROOF",
      reason: "instruction_send_attempt",
      prismaClient
    });
    const message = buildDirectReturnInstructionEmail({
      request,
      group,
      instruction,
      token: issued.token
    });
    const emailResult = await sendEmailImpl({
      prismaClient,
      withdrawalRequest: group.withdrawalRequest,
      emailType: "direct_return_instruction",
      subject: message.subject,
      bodyText: message.text,
      bodyHtml: message.html,
      toEmail: group.withdrawalRequest.customerEmail,
      returnGroupId: group.id,
      instructionId: instruction.id
    });
    if (!emailResult?.ok) {
      await prismaClient.withdrawalAccessToken.update({
        where: {
          id: issued.record.id
        },
        data: {
          revokedAt: new Date(),
          revokedReason: "instruction_email_failed"
        }
      });
      return {
        ok: false,
        status: 502,
        error: "instruction_email_failed",
        instruction,
        emailResult
      };
    }
    const sentAt = emailResult.sentAt || new Date();
    await prismaClient.withdrawalReturnInstruction.update({
      where: {
        id: instruction.id
      },
      data: {
        status: "SENT",
        sentAt,
        sentBy: changedBy
      }
    });
    await prismaClient.withdrawalReturnGroup.update({
      where: {
        id: group.id
      },
      data: {
        instructionStatus: "SENT",
        instructionsSentAt: sentAt,
        operationalReturnDeadlineAt: deadline,
        returnAddressId: group.returnAddress.id,
        blockedReason: null
      }
    });
    await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
    const storeEmail = text(group.vendorStore?.vendorAuth?.managementEmail || group.vendorStore?.email);
    let storeEmailResult = null;
    if (storeEmail) {
      const storeMessage = buildDirectReturnStoreNotificationEmail({
        group,
        instruction
      });
      try {
        storeEmailResult = await sendEmailImpl({
          prismaClient,
          withdrawalRequest: group.withdrawalRequest,
          emailType: "direct_return_store_notice",
          subject: storeMessage.subject,
          bodyText: storeMessage.text,
          bodyHtml: storeMessage.html,
          toEmail: storeEmail,
          returnGroupId: group.id,
          instructionId: instruction.id
        });
      } catch (error) {
        storeEmailResult = {
          ok: false,
          error: text(error?.message) || "store_notification_failed"
        };
      }
    }
    return {
      ok: true,
      instruction: {
        ...instruction,
        status: "SENT",
        sentAt,
        sentBy: changedBy
      },
      group,
      emailResult,
      storeEmailResult,
      warning: !storeEmail ? "store_notification_email_missing" : storeEmailResult && !storeEmailResult.ok ? "store_notification_failed" : null
    };
  }
  return {
    ok: true,
    instruction,
    group
  };
}
export async function issueWithdrawalGroupAccessToken({
  returnGroupId,
  purpose = "RETURN_PROOF",
  reason = null,
  prismaClient = prisma
} = {}) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const token = await prismaClient.withdrawalAccessToken.create({
    data: {
      returnGroupId,
      purpose,
      tokenHash: hashToken(rawToken),
      expiresAt: addDays(new Date(), TOKEN_TTL_DAYS),
      issuedReason: reason
    }
  });
  return {
    token: rawToken,
    record: token
  };
}
export function getReturnProofPublicUrl({
  request,
  groupId,
  token,
  locale = null
}) {
  const configured = text(process.env.WITHDRAWAL_PUBLIC_BASE_URL);
  const origin = configured || (request ? new URL(request.url).origin : "");
  const url = new URL("/apps/vendors/withdrawal/return-proof", origin);
  url.searchParams.set("group", groupId);
  url.searchParams.set("token", token);
  if (locale) url.searchParams.set("lang", locale);
  return url.toString();
}
export function buildDirectReturnInstructionEmail({
  request,
  group,
  instruction,
  token
}) {
  const address = jsonObject(instruction.addressSnapshotJson);
  const items = jsonArray(instruction.itemsSnapshotJson);
  const deadline = jsonObject(instruction.deadlineSnapshotJson);
  const locale = group.withdrawalRequest.correspondenceLocale === "en-GB" ? "en-GB" : "ja-JP";
  const proofUrl = getReturnProofPublicUrl({
    request,
    groupId: group.id,
    token,
    locale
  });
  const localized = jsonObject(address.localizedInstructions)[locale] || {};
  const internationalLines = jsonArray(address.internationalAddressLines);
  const addressLines = locale === "en-GB" && internationalLines.length > 0 ? [address.internationalRecipientName || localized.recipientDisplayName, ...internationalLines].filter(Boolean) : [address.recipientName, address.postalCode, [address.countryLabel || address.countryCode, address.region, address.city].filter(Boolean).join(" "), address.address1, address.address2].filter(Boolean);
  if (locale === "en-GB") {
    const lines = [`Dear ${group.withdrawalRequest.customerName || "customer"},`, "", `Return instructions for ${group.storeNameSnapshot || "the selling store"}.`, "If goods from more than one store are being returned, send a separate parcel to each store.", "", "Goods to return", ...items.map(item => `- ${item.title || "Item"} x ${Number(item.quantity || 0)}`), "", "Return address", ...addressLines, address.phoneE164 ? `Telephone: ${address.phoneE164}` : "", localized.returnInstructions ? `Instructions: ${localized.returnInstructions}` : "", `Return by: ${deadline.operationalReturnDeadlineAt || "See the administrator's instructions"}`, group.returnShippingPayer === "SELLER" ? "The selling store will bear the direct return cost. Follow the method provided." : "You may have to bear the direct return cost unless the selling store agrees otherwise or applicable law requires the store to bear it.", "Where the withdrawal is accepted, the price and the least expensive standard outbound delivery cost are assessed for reimbursement. Extra delivery costs may be excluded.", "", `Submit the tracking number or tracking URL for this store here: ${proofUrl}`].filter(line => line !== "");
    return {
      subject: `[${group.storeNameSnapshot || "Selling store"}] Return instructions`,
      text: lines.join("\n"),
      html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join(""),
      proofUrl
    };
  }
  const returnShippingMessage = group.returnShippingPayer === "SELLER" ? "返送送料は販売店舗が負担します。案内された返送方法に従ってください。" : "返送送料は、販売店舗が別途負担すると案内した場合または法令上必要な場合を除き、お客様負担となる場合があります。";
  const lines = [`${group.withdrawalRequest.customerName || "お客様"} 様`, "", `${group.storeNameSnapshot || "販売店舗"}への返送方法をご案内します。`, "複数店舗の商品を撤回する場合は、店舗ごとに別の荷物で返送してください。", "", "返送する商品", ...items.map(item => `- ${item.title || "商品"} x ${Number(item.quantity || 0)}`), "", "返送先", ...addressLines, address.phone ? `電話番号: ${address.phone}` : "", address.instructions ? `注意事項: ${address.instructions}` : "", `返送期限: ${deadline.operationalReturnDeadlineAt || "管理者からの案内をご確認ください"}`, returnShippingMessage, "撤回が認められる場合、商品代金と通常配送方法に相当する初回送料を返金対象として確認します。通常配送より高い配送方法の追加費用は返金対象外となる場合があります。", "", `返送後、店舗ごとの追跡番号または追跡URLをこちらから提出してください: ${proofUrl}`].filter(line => line !== "");
  const textBody = lines.join("\n");
  return {
    subject: `【${group.storeNameSnapshot || "販売店舗"}】返送方法のご案内`,
    text: textBody,
    html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join(""),
    proofUrl
  };
}
export function buildDirectReturnStoreNotificationEmail({
  group,
  instruction
}) {
  const items = jsonArray(instruction.itemsSnapshotJson);
  const deadline = jsonObject(instruction.deadlineSnapshotJson);
  const orderReference = group.withdrawalRequest.shopifyOrderName || group.withdrawalRequest.shopifyOrderNumber || group.withdrawalRequest.id;
  const lines = [`${group.storeNameSnapshot || "販売店舗"} ご担当者様`, "", "購入者へ返送方法を案内しました。返送品の受領準備をお願いします。", `注文: ${orderReference}`, `撤回申請ID: ${group.withdrawalRequest.id}`, "", "返送予定の商品", ...items.map(item => `- ${item.title || "商品"} x ${Number(item.quantity || 0)}`), "", `返送期限: ${deadline.operationalReturnDeadlineAt || "管理画面をご確認ください"}`, "到着後、店舗管理画面で受領数量と商品状態を記録してください。返金判断は運営が行います。"];
  const textBody = lines.join("\n");
  return {
    subject: `【返品予定】${orderReference} の返送案内を送信しました`,
    text: textBody,
    html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join("")
  };
}
function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
