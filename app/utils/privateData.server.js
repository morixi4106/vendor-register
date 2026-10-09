import crypto from "node:crypto";

import { hashPrivateIdentifier } from "./privacyHash.server.js";

const PREFIX = "private:v1:";
const STORE_FIELDS = ["ownerName", "email", "phone", "address", "note"];

function encryptionKey(env) {
  const value = String(env.PRIVACY_ENCRYPTION_KEY || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("privacy_encryption_key_missing");
  }
  return Buffer.from(value, "hex");
}

export function encryptPrivateValue(value, { env = process.env } = {}) {
  if (value == null || value === "") return value;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey(env),
    nonce,
  );
  cipher.setAAD(Buffer.from(PREFIX));
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return (
    PREFIX +
    Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    )
  );
}

export function decryptPrivateValue(value, { env = process.env } = {}) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  try {
    const bytes = Buffer.from(value.slice(PREFIX.length), "base64url");
    if (bytes.length < 29) throw new Error("invalid_envelope");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(env),
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(PREFIX));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("private_data_unavailable");
  }
}

export function privateEmailLookupHash(email, { env = process.env } = {}) {
  return hashPrivateIdentifier(
    `vendor-email:${String(email || "")
      .trim()
      .toLowerCase()}`,
    { env },
  );
}

export function protectVendorStoreContact(data, options = {}) {
  const result = { ...data };
  for (const field of STORE_FIELDS) {
    if (Object.hasOwn(data, field))
      result[field] = encryptPrivateValue(data[field], options);
  }
  if (Object.hasOwn(data, "email"))
    result.emailLookupHash = privateEmailLookupHash(data.email, options);
  return result;
}

export function protectVendorManagementEmail(email, options = {}) {
  return {
    managementEmail: encryptPrivateValue(
      String(email).trim().toLowerCase(),
      options,
    ),
    managementEmailLookupHash: privateEmailLookupHash(email, options),
  };
}

export function vendorEmailLookupWhere(
  email,
  { management = false, env = process.env } = {},
) {
  const field = management ? "managementEmail" : "email";
  const hashField = management
    ? "managementEmailLookupHash"
    : "emailLookupHash";
  return {
    OR: [
      { [hashField]: privateEmailLookupHash(email, { env }) },
      {
        [field]: {
          equals: String(email).trim().toLowerCase(),
          mode: "insensitive",
        },
        [hashField]: null,
      },
    ],
  };
}

export function readVendorContacts(record, options = {}) {
  if (!record || typeof record !== "object") return record;
  if (Array.isArray(record))
    return record.map((item) => readVendorContacts(item, options));
  const result = { ...record };
  for (const field of [...STORE_FIELDS, "managementEmail"]) {
    if (Object.hasOwn(result, field))
      result[field] = decryptPrivateValue(result[field], options);
  }
  for (const relation of ["vendor", "vendorStore", "vendorAuth", "seller"]) {
    if (result[relation])
      result[relation] = readVendorContacts(result[relation], options);
  }
  delete result.emailLookupHash;
  delete result.managementEmailLookupHash;
  return result;
}

export function privateErrorCode(error) {
  const code = String(error?.code || "");
  return /^P\d{4}$/.test(code) ? code : "operation_failed";
}

export function omitContactCopies(snapshot) {
  if (!snapshot) return snapshot;
  const result = { ...snapshot };
  for (const field of [
    "customerName",
    "customerEmail",
    "customerPhone",
    "buyerName",
    "buyerEmail",
    "shippingAddress",
  ])
    delete result[field];
  return result;
}

const INQUIRY_FIELDS = ["name", "email", "phone", "message", "replyText"];

export function protectContactInquiry(data, options = {}) {
  const result = { ...data };
  result.emailLookupHash = hashPrivateIdentifier(
    `contact-email:${String(data.email || "")
      .trim()
      .toLowerCase()}`,
    options,
  );
  for (const field of INQUIRY_FIELDS)
    result[field] = encryptPrivateValue(data[field], options);
  return result;
}

export function readContactInquiry(data, options = {}) {
  const result = { ...data };
  for (const field of INQUIRY_FIELDS)
    result[field] = decryptPrivateValue(data[field], options);
  delete result.emailLookupHash;
  return result;
}
