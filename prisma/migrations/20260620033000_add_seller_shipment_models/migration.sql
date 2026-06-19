CREATE TABLE IF NOT EXISTS "seller_shipments" (
  "id" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "shopifyFulfillmentId" TEXT,
  "trackingNumber" TEXT,
  "trackingCompany" TEXT,
  "trackingUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'registered',
  "shippedAt" TIMESTAMP(3),
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "seller_shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "seller_shipment_lines" (
  "id" TEXT NOT NULL,
  "sellerShipmentId" TEXT NOT NULL,
  "sellerOrderLineId" TEXT NOT NULL,
  "shopifyLineItemId" TEXT,
  "shopifyFulfillmentOrderId" TEXT NOT NULL,
  "shopifyFulfillmentOrderLineItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "seller_shipment_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "seller_shipments_sellerOrderId_createdAt_idx"
  ON "seller_shipments"("sellerOrderId", "createdAt");

CREATE INDEX IF NOT EXISTS "seller_shipments_shopifyFulfillmentId_idx"
  ON "seller_shipments"("shopifyFulfillmentId");

CREATE INDEX IF NOT EXISTS "seller_shipments_trackingNumber_idx"
  ON "seller_shipments"("trackingNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "seller_shipment_lines_sellerShipmentId_shopifyFulfillmentOrderLineItemId_key"
  ON "seller_shipment_lines"("sellerShipmentId", "shopifyFulfillmentOrderLineItemId");

CREATE INDEX IF NOT EXISTS "seller_shipment_lines_sellerOrderLineId_idx"
  ON "seller_shipment_lines"("sellerOrderLineId");

CREATE INDEX IF NOT EXISTS "seller_shipment_lines_shopifyLineItemId_idx"
  ON "seller_shipment_lines"("shopifyLineItemId");

CREATE INDEX IF NOT EXISTS "seller_shipment_lines_shopifyFulfillmentOrderId_idx"
  ON "seller_shipment_lines"("shopifyFulfillmentOrderId");

ALTER TABLE "seller_shipments"
  ADD CONSTRAINT "seller_shipments_sellerOrderId_fkey"
  FOREIGN KEY ("sellerOrderId")
  REFERENCES "seller_orders"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "seller_shipment_lines"
  ADD CONSTRAINT "seller_shipment_lines_sellerShipmentId_fkey"
  FOREIGN KEY ("sellerShipmentId")
  REFERENCES "seller_shipments"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "seller_shipment_lines"
  ADD CONSTRAINT "seller_shipment_lines_sellerOrderLineId_fkey"
  FOREIGN KEY ("sellerOrderLineId")
  REFERENCES "seller_order_lines"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
