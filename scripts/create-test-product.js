import prisma from "../app/db.server.js";

async function main() {
  await prisma.product.updateMany({
    where: {
      vendorStoreId: "cmmxu791m0000sf2c2k5ux750"
    },
    data: {
      url: "ここに本物の商品URL"
    }
  });

  console.log("商品URL更新完了");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });