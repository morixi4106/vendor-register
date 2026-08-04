import prisma from "../../db.server.js";
import { normalizeReturnAddressInput, recomputeWithdrawalV2State, text } from "./common.js";
export const RETURN_ADDRESS_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE"
});
export async function getVendorReturnAddressState(vendorStoreId, prismaClient = prisma) {
  const addresses = await prismaClient.vendorReturnAddress.findMany({
    where: {
      vendorStoreId: text(vendorStoreId)
    },
    include: {
      locales: true
    },
    orderBy: [{
      version: "desc"
    }]
  });
  return {
    active: addresses.find(address => address.status === RETURN_ADDRESS_STATUSES.ACTIVE) || null,
    draft: addresses.find(address => address.status === RETURN_ADDRESS_STATUSES.DRAFT) || null,
    history: addresses.filter(address => address.status === RETURN_ADDRESS_STATUSES.INACTIVE)
  };
}
export async function saveVendorReturnAddressDraft({
  vendorStoreId,
  values,
  changedBy = "vendor",
  prismaClient = prisma
} = {}) {
  const normalized = normalizeReturnAddressInput(values);
  if (!normalized.ok) return {
    ok: false,
    status: 400,
    errors: normalized.errors
  };
  const state = await getVendorReturnAddressState(vendorStoreId, prismaClient);
  const maxVersion = [state.active, state.draft, ...state.history].reduce((max, address) => Math.max(max, Number(address?.version || 0)), 0);
  const confirmationComplete = normalized.data.canReceiveReturnsConfirmed && normalized.data.buyerDisclosureConfirmed && normalized.data.legalRecipientConfirmed;
  const common = {
    ...normalized.data,
    confirmedAt: confirmationComplete ? new Date() : null,
    confirmedBy: confirmationComplete ? changedBy : null
  };
  const draft = state.draft ? await prismaClient.vendorReturnAddress.update({
    where: {
      id: state.draft.id
    },
    data: common
  }) : await prismaClient.vendorReturnAddress.create({
    data: {
      vendorStoreId,
      version: maxVersion + 1,
      status: "DRAFT",
      ...common
    }
  });
  if (prismaClient.vendorReturnAddressLocale?.upsert) {
    const localizedValues = [{
      locale: "ja-JP",
      returnInstructions: text(values.instructions) || null,
      recipientDisplayName: normalized.data.recipientName
    }, {
      locale: "en-GB",
      returnInstructions: text(values.instructionsEn) || null,
      recipientDisplayName: normalized.data.internationalRecipientName || normalized.data.recipientName
    }];
    for (const localized of localizedValues) {
      await prismaClient.vendorReturnAddressLocale.upsert({
        where: {
          returnAddressId_locale: {
            returnAddressId: draft.id,
            locale: localized.locale
          }
        },
        create: {
          returnAddressId: draft.id,
          ...localized
        },
        update: localized
      });
    }
  }
  return {
    ok: true,
    draft
  };
}
export async function activateVendorReturnAddress({
  vendorStoreId,
  draftId,
  changedBy = "vendor",
  prismaClient = prisma
} = {}) {
  const draft = await prismaClient.vendorReturnAddress.findFirst({
    where: {
      id: text(draftId),
      vendorStoreId: text(vendorStoreId),
      status: "DRAFT"
    }
  });
  if (!draft) return {
    ok: false,
    status: 404,
    error: "draft_not_found"
  };
  if (draft.countryCode === "JP" && (!draft.internationalRecipientName || !Array.isArray(draft.internationalAddressLines) || draft.internationalAddressLines.length === 0)) {
    return {
      ok: false,
      status: 400,
      error: "international_address_required"
    };
  }
  if (!draft.canReceiveReturnsConfirmed || !draft.buyerDisclosureConfirmed || !draft.legalRecipientConfirmed || !draft.confirmedAt) {
    return {
      ok: false,
      status: 400,
      error: "confirmation_required"
    };
  }
  const now = new Date();
  const affectedRequestIds = await prismaClient.$transaction(async tx => {
    await tx.vendorReturnAddress.updateMany({
      where: {
        vendorStoreId,
        status: "ACTIVE"
      },
      data: {
        status: "INACTIVE",
        deactivatedAt: now,
        deactivatedBy: changedBy
      }
    });
    const activeAddress = await tx.vendorReturnAddress.update({
      where: {
        id: draft.id
      },
      data: {
        status: "ACTIVE",
        activatedAt: now,
        activatedBy: changedBy
      }
    });
    const affectedGroups = await tx.withdrawalReturnGroup.findMany({
      where: {
        vendorStoreId,
        instructionsSentAt: null
      },
      select: {
        withdrawalRequestId: true
      }
    });
    await tx.withdrawalReturnGroup.updateMany({
      where: {
        vendorStoreId,
        instructionsSentAt: null
      },
      data: {
        returnAddressId: activeAddress.id,
        routingStatus: "READY",
        instructionStatus: "READY",
        progressStatus: "READY_FOR_INSTRUCTIONS",
        blockedReason: null
      }
    });
    return [...new Set(affectedGroups.map(group => group.withdrawalRequestId))];
  });
  for (const requestId of affectedRequestIds) {
    await recomputeWithdrawalV2State(requestId, prismaClient);
  }
  return {
    ok: true
  };
}
export function returnAddressFromFormData(formData) {
  const consolidatedConfirmation = formData.get("returnAddressConfirmed") === "on";
  return {
    recipientName: formData.get("recipientName"),
    postalCode: formData.get("postalCode"),
    countryCode: formData.get("countryCode"),
    countryLabel: formData.get("countryLabel"),
    region: formData.get("region"),
    city: formData.get("city"),
    address1: formData.get("address1"),
    address2: formData.get("address2"),
    phone: formData.get("phone"),
    instructions: formData.get("instructions"),
    internationalRecipientName: formData.get("internationalRecipientName"),
    internationalAddressLines: formData.get("internationalAddressLines"),
    phoneE164: formData.get("phoneE164"),
    instructionsEn: formData.get("instructionsEn"),
    canReceiveReturnsConfirmed: consolidatedConfirmation || formData.get("canReceiveReturnsConfirmed") === "on",
    buyerDisclosureConfirmed: consolidatedConfirmation || formData.get("buyerDisclosureConfirmed") === "on",
    legalRecipientConfirmed: consolidatedConfirmation || formData.get("legalRecipientConfirmed") === "on"
  };
}
