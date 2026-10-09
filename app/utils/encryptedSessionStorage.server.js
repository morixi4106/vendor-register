import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  decryptPrivateValue,
  encryptPrivateValue,
} from "./privateData.server.js";

export class EncryptedPrismaSessionStorage extends PrismaSessionStorage {
  async storeSession(session) {
    const protectedSession = Object.assign(
      Object.create(Object.getPrototypeOf(session)),
      session,
      {
        accessToken: encryptPrivateValue(session.accessToken),
        refreshToken: encryptPrivateValue(session.refreshToken),
      },
    );
    return super.storeSession(protectedSession);
  }

  async loadSession(id) {
    return restoreSession(await super.loadSession(id));
  }
  async findSessionsByShop(shop) {
    return (await super.findSessionsByShop(shop)).map(restoreSession);
  }
}

function restoreSession(session) {
  if (!session) return session;
  session.accessToken = decryptPrivateValue(session.accessToken);
  session.refreshToken = decryptPrivateValue(session.refreshToken);
  return session;
}
