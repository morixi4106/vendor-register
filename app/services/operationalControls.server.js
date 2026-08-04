import prisma from "../db.server.js";

export const PLATFORM_OPERATIONAL_CONTROL_KEY = "GLOBAL";

export const OPERATIONAL_CONTROL_TYPE = Object.freeze({
  PURCHASE_STOP: "PURCHASE_STOP",
  EMAIL_AUTOMATION_STOP: "EMAIL_AUTOMATION_STOP",
  EMAIL_ORDER_STOP: "EMAIL_ORDER_STOP",
  EMAIL_LEGAL_STOP: "EMAIL_LEGAL_STOP",
  EMAIL_SECURITY_STOP: "EMAIL_SECURITY_STOP",
});

export const OPERATIONAL_CONTROL_STATE = Object.freeze({
  REQUESTED: "REQUESTED",
  ACTIVATING: "ACTIVATING",
  ACTIVE: "ACTIVE",
  PARTIAL_FAILURE: "PARTIAL_FAILURE",
  RECOVERY_REQUESTED: "RECOVERY_REQUESTED",
  RECOVERING: "RECOVERING",
  RECOVERED: "RECOVERED",
  RECOVERY_FAILED: "RECOVERY_FAILED",
});

export const EMAIL_MESSAGE_CLASS = Object.freeze({
  SECURITY: "SECURITY",
  LEGAL_TRANSACTIONAL: "LEGAL_TRANSACTIONAL",
  ORDER_TRANSACTIONAL: "ORDER_TRANSACTIONAL",
  SUPPORT: "SUPPORT",
  AUTOMATION: "AUTOMATION",
  MONITORING: "MONITORING",
});

const EMAIL_CLASS_CONTROL = Object.freeze({
  [EMAIL_MESSAGE_CLASS.AUTOMATION]: {
    field: "automatedEmailHold",
    metadataKey: "emailAutomation",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_AUTOMATION_STOP,
  },
  [EMAIL_MESSAGE_CLASS.SUPPORT]: {
    field: "automatedEmailHold",
    metadataKey: "emailAutomation",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_AUTOMATION_STOP,
  },
  [EMAIL_MESSAGE_CLASS.ORDER_TRANSACTIONAL]: {
    field: "orderEmailHold",
    metadataKey: "emailOrder",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_ORDER_STOP,
  },
  [EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL]: {
    field: "legalEmailHold",
    metadataKey: "emailLegal",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_LEGAL_STOP,
  },
  [EMAIL_MESSAGE_CLASS.SECURITY]: {
    field: "securityEmailHold",
    metadataKey: "emailSecurity",
    controlType: OPERATIONAL_CONTROL_TYPE.EMAIL_SECURITY_STOP,
  },
});

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

export async function getPlatformOperationalControl({
  prismaClient = prisma,
} = {}) {
  if (!prismaClient?.platformOperationalControl?.findUnique) {
    return {
      key: PLATFORM_OPERATIONAL_CONTROL_KEY,
      checkoutHold: false,
      automatedEmailHold: false,
      orderEmailHold: false,
      legalEmailHold: false,
      securityEmailHold: false,
      internationalShippingHold: false,
      checkoutControlState: "IDLE",
      available: false,
    };
  }

  const control = await prismaClient.platformOperationalControl.findUnique({
    where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
  });

  return {
    key: PLATFORM_OPERATIONAL_CONTROL_KEY,
    checkoutHold: false,
    automatedEmailHold: false,
    orderEmailHold: false,
    legalEmailHold: false,
    securityEmailHold: false,
    internationalShippingHold: false,
    checkoutControlState: "IDLE",
    available: true,
    ...control,
  };
}

export async function isPlatformCheckoutHoldActive(options = {}) {
  const control = await getPlatformOperationalControl(options);
  return control.checkoutHold === true;
}

export async function isAutomatedEmailHoldActive(options = {}) {
  const control = await getPlatformOperationalControl(options);
  return control.automatedEmailHold === true;
}

export function getEmailClassControl(messageClass) {
  return EMAIL_CLASS_CONTROL[normalizeUpper(messageClass)] || null;
}

export async function isEmailClassHoldActive(messageClass, options = {}) {
  const status = await getEmailClassHoldStatus(messageClass, options);
  return status.active;
}

export async function getEmailClassHoldStatus(
  messageClass,
  { prismaClient = prisma } = {},
) {
  const normalizedClass = normalizeUpper(messageClass);
  if (normalizedClass === EMAIL_MESSAGE_CLASS.MONITORING) {
    return {
      active: false,
      messageClass: normalizedClass,
      control: null,
      platformControl: null,
    };
  }

  const mapping = getEmailClassControl(normalizedClass);
  if (!mapping) {
    return {
      active: false,
      messageClass: normalizedClass,
      control: null,
      platformControl: null,
    };
  }

  const platformControl = await getPlatformOperationalControl({ prismaClient });
  const active = platformControl[mapping.field] === true;
  const control =
    active && prismaClient?.operationalControl?.findFirst
      ? await prismaClient.operationalControl.findFirst({
          where: {
            controlType: mapping.controlType,
            activeKey: { not: null },
            state: {
              in: [
                OPERATIONAL_CONTROL_STATE.ACTIVE,
                OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE,
                OPERATIONAL_CONTROL_STATE.RECOVERY_REQUESTED,
                OPERATIONAL_CONTROL_STATE.RECOVERING,
                OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
              ],
            },
          },
          orderBy: { requestedAt: "desc" },
        })
      : null;

  return {
    active,
    messageClass: normalizedClass,
    control,
    platformControl,
    reason:
      normalizeText(control?.reasonText) ||
      normalizeText(platformControl?.holdReason),
  };
}
