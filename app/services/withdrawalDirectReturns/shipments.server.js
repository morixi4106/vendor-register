import { Prisma } from "@prisma/client";
import prisma from "../../db.server.js";
import { MAX_TRANSACTION_RETRIES, hashToken, isGroupTerminal, jsonObject, recomputeWithdrawalV2State, text } from "./common.js";
export async function findWithdrawalGroupByToken({
  returnGroupId,
  token,
  purpose = "RETURN_PROOF",
  prismaClient = prisma
} = {}) {
  const tokenHash = hashToken(token);
  const accessToken = await prismaClient.withdrawalAccessToken.findFirst({
    where: {
      returnGroupId: text(returnGroupId),
      purpose,
      tokenHash,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    include: {
      returnGroup: {
        include: {
          withdrawalRequest: true,
          lines: {
            include: {
              requestedLine: true
            }
          },
          shipments: {
            include: {
              lines: true
            },
            orderBy: {
              packageNumber: "asc"
            }
          },
          instructions: {
            where: {
              status: "SENT"
            },
            orderBy: {
              version: "desc"
            },
            take: 1
          }
        }
      }
    }
  });
  if (!accessToken || isGroupTerminal(accessToken.returnGroup)) {
    return {
      ok: false,
      status: 404,
      error: "invalid_access_link"
    };
  }
  const now = new Date();
  await prismaClient.withdrawalAccessToken.update({
    where: {
      id: accessToken.id
    },
    data: {
      firstUsedAt: accessToken.firstUsedAt || now,
      lastUsedAt: now
    }
  });
  return {
    ok: true,
    accessToken,
    returnGroup: accessToken.returnGroup
  };
}
export async function submitWithdrawalGroupShipment({
  returnGroupId,
  token,
  values,
  prismaClient = prisma
} = {}) {
  const lookup = await findWithdrawalGroupByToken({
    returnGroupId,
    token,
    prismaClient
  });
  if (!lookup.ok) return lookup;
  const group = lookup.returnGroup;
  const trackingNumber = text(values.trackingNumber);
  const trackingUrl = text(values.trackingUrl);
  if (!trackingNumber && !trackingUrl) {
    return {
      ok: false,
      status: 400,
      error: "tracking_required"
    };
  }
  const quantities = jsonObject(values.quantities);
  let shipment = null;
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      shipment = await prismaClient.$transaction(async tx => {
        const freshGroup = await tx.withdrawalReturnGroup.findUnique({
          where: {
            id: group.id
          },
          include: {
            lines: true
          }
        });
        if (!freshGroup || isGroupTerminal(freshGroup)) {
          throw createSubmissionError("invalid_access_link", 404);
        }
        const requestedByLine = new Map(freshGroup.lines.map(line => [line.id, line]));
        const shipmentLines = [];
        for (const [lineId, rawQuantity] of Object.entries(quantities)) {
          const groupLine = requestedByLine.get(lineId);
          const quantity = Number(rawQuantity || 0);
          if (!groupLine || !Number.isInteger(quantity) || quantity <= 0) continue;
          const available = Number(groupLine.instructedQuantity || 0) - Number(groupLine.submittedQuantity || 0);
          if (quantity > available) {
            throw createSubmissionError("shipment_quantity_exceeded", 409);
          }
          shipmentLines.push({
            groupLine,
            quantity
          });
        }
        if (!shipmentLines.length) {
          throw createSubmissionError("shipment_lines_required", 400);
        }
        const packageCount = await tx.withdrawalReturnShipment.count({
          where: {
            returnGroupId: freshGroup.id
          }
        });
        const created = await tx.withdrawalReturnShipment.create({
          data: {
            returnGroupId: freshGroup.id,
            packageNumber: packageCount + 1,
            trackingCompany: text(values.trackingCompany) || null,
            trackingNumber: trackingNumber || null,
            trackingUrl: trackingUrl || null,
            customerMemo: text(values.customerMemo) || null,
            proofJson: jsonObject(values.proofJson),
            submittedAt: new Date()
          }
        });
        for (const item of shipmentLines) {
          const updated = await tx.withdrawalReturnGroupLine.updateMany({
            where: {
              id: item.groupLine.id,
              submittedQuantity: Number(item.groupLine.submittedQuantity || 0)
            },
            data: {
              submittedQuantity: {
                increment: item.quantity
              }
            }
          });
          if (updated.count !== 1) {
            throw createSubmissionError("shipment_submission_conflict", 409);
          }
          await tx.withdrawalReturnShipmentLine.create({
            data: {
              shipmentId: created.id,
              returnGroupLineId: item.groupLine.id,
              submittedQuantity: item.quantity
            }
          });
        }
        await tx.withdrawalReturnGroup.update({
          where: {
            id: freshGroup.id
          },
          data: {
            evidenceStatus: "SUBMITTED"
          }
        });
        return created;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
      break;
    } catch (error) {
      const retryable = error?.code === "P2034" || error?.code === "P2002" || error?.message === "shipment_submission_conflict";
      if (retryable && attempt + 1 < MAX_TRANSACTION_RETRIES) continue;
      if (error?.publicStatus) {
        return {
          ok: false,
          status: error.publicStatus,
          error: error.message
        };
      }
      if (retryable) {
        return {
          ok: false,
          status: 409,
          error: "shipment_submission_conflict"
        };
      }
      throw error;
    }
  }
  if (!shipment) {
    return {
      ok: false,
      status: 409,
      error: "shipment_submission_conflict"
    };
  }
  await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
  return {
    ok: true,
    shipment
  };
}
function createSubmissionError(message, status) {
  const error = new Error(message);
  error.publicStatus = status;
  return error;
}
