import prisma from "../app/db.server.js";

async function main() {
  await prisma.product.updateMany({
    where: {
      vendorStoreId: "cmmxu791m0000sf2c2k5ux750"
    },
    data: {
      url: "https://example.com"
    }
  });

  console.log("URL追加完了");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });