import prisma from "../../db.server.js";
export async function updateVendorSettings({
  vendorId,
  storeId,
  storeName,
  managementEmail
}) {
  const normalizedStoreName = String(storeName || "").trim();
  const normalizedManagementEmail = String(managementEmail || "").trim();
  try {
    await prisma.$transaction(async tx => {
      const vendorResult = await tx.vendor.updateMany({
        where: {
          id: vendorId,
          vendorStoreId: storeId
        },
        data: {
          storeName: normalizedStoreName,
          managementEmail: normalizedManagementEmail
        }
      });
      if (vendorResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }
      const storeResult = await tx.vendorStore.updateMany({
        where: {
          id: storeId
        },
        data: {
          storeName: normalizedStoreName
        }
      });
      if (storeResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }
    });
    return {
      ok: true
    };
  } catch (error) {
    if (error instanceof Error && error.message === "VENDOR_SETTINGS_NOT_FOUND") {
      return {
        ok: false,
        status: 404,
        publicError: "店舗情報が見つかりません。"
      };
    }
    console.error("vendor settings update error:", error);
    return {
      ok: false,
      status: 500,
      publicError: "設定の保存に失敗しました。時間を置いて再度お試しください。"
    };
  }
}
