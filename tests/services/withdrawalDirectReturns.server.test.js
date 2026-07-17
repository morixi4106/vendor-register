import assert from "node:assert/strict";
import test from "node:test";

import {
  __testables,
  activateVendorReturnAddress,
  buildDirectReturnInstructionEmail,
  buildDirectReturnStoreNotificationEmail,
  findWithdrawalGroupByToken,
  reconcileWithdrawalCancellationWebhook,
  returnAddressFromFormData,
  submitWithdrawalGroupShipment,
  updateWithdrawalGroupReview,
} from "../../app/services/withdrawalDirectReturns.server.js";

test("one return address confirmation preserves all audit confirmations", () => {
  const formData = new FormData();
  formData.set("returnAddressConfirmed", "on");
  const values = returnAddressFromFormData(formData);

  assert.equal(values.canReceiveReturnsConfirmed, true);
  assert.equal(values.buyerDisclosureConfirmed, true);
  assert.equal(values.legalRecipientConfirmed, true);
});

test("initial shipping allocation is integer-safe and never duplicated", () => {
  const result = __testables.allocateIntegerByWeight(870, [
    { key: "store_a", weight: 65 },
    { key: "store_b", weight: 179 },
  ]);

  assert.equal(result.get("store_a") + result.get("store_b"), 870);
  assert.equal(result.get("store_a"), 232);
  assert.equal(result.get("store_b"), 638);
});

test("shipping-only refunds target one request with an outstanding shipping plan", () => {
  const requests = [
    {
      id: "withdrawal_1",
      contracts: [{ initialShippingRefundStatus: "NOT_REFUNDABLE", initialShippingRefundAmount: 870 }],
      actualRefundEvents: [],
    },
    {
      id: "withdrawal_2",
      contracts: [{ initialShippingRefundStatus: "PLANNED", initialShippingRefundAmount: 870 }],
      actualRefundEvents: [],
    },
  ];
  const allocations = new Map(requests.map((request) => [request.id, []]));

  assert.equal(__testables.getOutstandingInitialShippingAmount(requests[0]), 0);
  assert.equal(__testables.getOutstandingInitialShippingAmount(requests[1]), 870);
  assert.equal(
    __testables.selectShippingRefundTargetRequest(requests, allocations).id,
    "withdrawal_2",
  );
});

test("actual shipping refunds reduce the outstanding amount", () => {
  const request = {
    contracts: [{ initialShippingRefundStatus: "REFUND_STANDARD", initialShippingRefundAmount: 870 }],
    actualRefundEvents: [{ initialShippingAmount: 500 }],
  };

  assert.equal(__testables.getOutstandingInitialShippingAmount(request), 370);
});

test("address snapshots do not change when the active address changes", () => {
  const address = {
    id: "address_1",
    version: 2,
    recipientName: "返品係",
    postalCode: "100-0001",
    countryCode: "JP",
    countryLabel: "日本",
    region: "東京都",
    city: "千代田区",
    address1: "千代田1-1",
    address2: null,
    phone: "03-0000-0000",
    instructions: "平日受領",
    confirmedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const snapshot = __testables.addressSnapshot(address);

  address.address1 = "変更後の住所";
  assert.equal(snapshot.address1, "千代田1-1");
  assert.equal(snapshot.sourceAddressId, "address_1");
  assert.equal(snapshot.sourceVersion, 2);
});

test("withdrawal aggregate requires all store groups to finish", () => {
  assert.deepEqual(
    __testables.deriveWithdrawalAggregate([
      { progressStatus: "COMPLETED", outcomeStatus: "FULL_REFUND" },
      { progressStatus: "COMPLETED", outcomeStatus: "PARTIAL_REFUND" },
    ]),
    { progressStatus: "COMPLETED", outcomeStatus: "MIXED" },
  );
  assert.deepEqual(
    __testables.deriveWithdrawalAggregate([
      { progressStatus: "COMPLETED", outcomeStatus: "FULL_REFUND" },
      { progressStatus: "IN_PROGRESS", outcomeStatus: "UNDECIDED" },
    ]),
    { progressStatus: "IN_PROGRESS", outcomeStatus: "UNDECIDED" },
  );
});

test("partial refund events accumulate without exceeding purchased quantity", () => {
  assert.equal(__testables.cumulativeRefundedQuantity(2, 0, 1), 1);
  assert.equal(__testables.cumulativeRefundedQuantity(2, 1, 1), 2);
  assert.equal(__testables.cumulativeRefundedQuantity(2, 2, 1), 2);
});

test("partial withdrawal does not map every line when structured selection is empty", () => {
  const selection = { values: new Set(), quantities: new Map() };
  const line = {
    id: "line_1",
    shopifyLineItemId: "gid://shopify/LineItem/1",
    quantity: 2,
    netAmount: 1000,
  };

  assert.equal(__testables.lineMatchesSelection(line, selection.values), false);
  assert.equal(
    __testables.mapOrderLine(
      line,
      { shopDomain: "example.myshopify.com", shopifyOrderId: "order_1" },
      selection,
      true,
    ),
    null,
  );
});

test("partial withdrawal uses the confirmed quantity without exceeding the order line", () => {
  const request = {
    selectedLineItemsJson: {
      selectedLineItems: ["line_1"],
      selectedLineQuantities: { line_1: 1 },
    },
  };
  const selection = __testables.getSelectedLineSelection(request);
  const mapped = __testables.mapOrderLine(
    {
      id: "line_1",
      shopifyLineItemId: "gid://shopify/LineItem/1",
      quantity: 2,
      netAmount: 1000,
      lineSubtotalAmount: 1200,
      discountAmount: 200,
      taxAmount: 100,
    },
    { shopDomain: "example.myshopify.com", shopifyOrderId: "order_1" },
    selection,
    true,
  );

  assert.equal(mapped.requestedQuantity, 1);
  assert.equal(mapped.amount, 500);
  assert.equal(mapped.subtotalAmount, 600);
  assert.equal(mapped.discountAmount, 100);
  assert.equal(mapped.taxAmount, 50);
});

test("admin partial line selection ignores invalid quantities and keeps the latest value", () => {
  const selections = __testables.normalizePartialLineSelections([
    { sellerOrderLineId: "line_1", quantity: 1 },
    { sellerOrderLineId: "line_1", quantity: 2 },
    { sellerOrderLineId: "line_2", quantity: 0 },
    { sellerOrderLineId: "line_3", quantity: "1.5" },
  ]);

  assert.deepEqual([...selections.entries()], [["line_1", 2]]);
});

test("order cancellation loads position quantities before releasing V2 lines", async () => {
  let capturedInclude = null;
  let cancelledQuantity = null;
  const requestedLines = [
    {
      orderLinePositionId: "position_1",
      reservedQuantity: 1,
      orderLinePosition: {
        purchasedQuantity: 2,
        cancelledQuantity: 0,
      },
    },
  ];
  const prismaClient = {
    withdrawalRequest: {
      async findMany({ include }) {
        capturedInclude = include;
        return [{ id: "withdrawal_1", requestedLines }];
      },
      async update() {},
    },
    async $transaction(callback) {
      return callback({
        withdrawalOrderLinePosition: {
          async update({ data }) {
            cancelledQuantity = data.cancelledQuantity;
          },
        },
        withdrawalReturnGroup: {
          async updateMany() {},
        },
      });
    },
    withdrawalReturnGroup: {
      async findMany() {
        return [{ progressStatus: "COMPLETED", outcomeStatus: "CANCELLED" }];
      },
    },
    withdrawalContract: {
      async findMany() {
        return [];
      },
    },
  };

  const result = await reconcileWithdrawalCancellationWebhook({
    shop: "example.myshopify.com",
    payload: { id: 1010 },
    prismaClient,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(capturedInclude, {
    requestedLines: { include: { orderLinePosition: true } },
  });
  assert.equal(cancelledQuantity, 1);
});

test("return proof token lookup is scoped to the owning return group", async () => {
  let capturedWhere = null;
  const expiresAt = new Date(Date.now() + 60_000);
  const prismaClient = {
    withdrawalAccessToken: {
      async findFirst({ where }) {
        capturedWhere = where;
        return {
          id: "token_1",
          firstUsedAt: null,
          expiresAt,
          returnGroup: { id: "group_1", outcomeStatus: "UNDECIDED" },
        };
      },
      async update() {},
    },
  };

  const result = await findWithdrawalGroupByToken({
    returnGroupId: "group_1",
    token: "secret-token",
    prismaClient,
  });

  assert.equal(result.ok, true);
  assert.equal(capturedWhere.returnGroupId, "group_1");
  assert.equal(capturedWhere.purpose, "RETURN_PROOF");
  assert.equal(capturedWhere.tokenHash, __testables.hashToken("secret-token"));
  assert.equal(capturedWhere.revokedAt, null);
  assert.ok(capturedWhere.expiresAt.gt instanceof Date);
});

test("a store return can be submitted as multiple packages but not over quantity", async () => {
  const group = {
    id: "group_1",
    withdrawalRequestId: "withdrawal_1",
    outcomeStatus: "UNDECIDED",
    progressStatus: "IN_PROGRESS",
    blockedReason: null,
    mappingStatus: "CONFIRMED",
    routingStatus: "READY",
    instructionStatus: "SENT",
    evidenceStatus: "NOT_SUBMITTED",
    receiptStatus: "NOT_RECEIVED",
    inspectionStatus: "NOT_INSPECTED",
    refundDecisionStatus: "UNDECIDED",
    lines: [
      {
        id: "group_line_1",
        instructedQuantity: 2,
        submittedQuantity: 0,
        requestedLine: { titleSnapshot: "商品A" },
      },
    ],
    shipments: [],
    instructions: [],
    withdrawalRequest: { id: "withdrawal_1" },
  };
  const tokenRecord = { id: "token_1", firstUsedAt: null };
  let shipmentSequence = 0;
  const prismaClient = {
    withdrawalAccessToken: {
      async findFirst() {
        return { ...tokenRecord, returnGroup: group };
      },
      async update() {},
    },
    async $transaction(callback) {
      return callback(this);
    },
    withdrawalReturnShipment: {
      async count() {
        return group.shipments.length;
      },
      async create({ data }) {
        shipmentSequence += 1;
        const shipment = { id: `shipment_${shipmentSequence}`, ...data, lines: [] };
        group.shipments.push(shipment);
        return shipment;
      },
    },
    withdrawalReturnShipmentLine: {
      async create({ data }) {
        group.shipments.at(-1).lines.push(data);
        return data;
      },
    },
    withdrawalReturnGroupLine: {
      async updateMany({ where, data }) {
        const line = group.lines.find((item) => item.id === where.id);
        if (!line || line.submittedQuantity !== where.submittedQuantity) {
          return { count: 0 };
        }
        line.submittedQuantity += Number(data.submittedQuantity.increment || 0);
        return { count: 1 };
      },
    },
    withdrawalReturnGroup: {
      async findUnique() {
        return { ...group, lines: group.lines.map((line) => ({ ...line })) };
      },
      async update({ data }) {
        Object.assign(group, data);
        return group;
      },
      async findMany() {
        return [group];
      },
    },
    withdrawalContract: {
      async findMany() {
        return [];
      },
    },
    withdrawalRequest: {
      async update({ data }) {
        return { id: "withdrawal_1", ...data };
      },
    },
  };

  const first = await submitWithdrawalGroupShipment({
    returnGroupId: group.id,
    token: "secret",
    values: {
      trackingNumber: "TRACK-1",
      quantities: { group_line_1: 1 },
    },
    prismaClient,
  });
  const second = await submitWithdrawalGroupShipment({
    returnGroupId: group.id,
    token: "secret",
    values: {
      trackingNumber: "TRACK-2",
      quantities: { group_line_1: 1 },
    },
    prismaClient,
  });
  const excessive = await submitWithdrawalGroupShipment({
    returnGroupId: group.id,
    token: "secret",
    values: {
      trackingNumber: "TRACK-3",
      quantities: { group_line_1: 1 },
    },
    prismaClient,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(group.shipments.length, 2);
  assert.equal(group.shipments[0].trackingNumber, "TRACK-1");
  assert.equal(group.shipments[1].trackingNumber, "TRACK-2");
  assert.equal(excessive.ok, false);
  assert.equal(excessive.error, "shipment_quantity_exceeded");
});

test("vendor review and return address activation are scoped by vendor store", async () => {
  let reviewWhere = null;
  const reviewResult = await updateWithdrawalGroupReview({
    returnGroupId: "group_1",
    vendorStoreId: "store_b",
    values: {},
    prismaClient: {
      withdrawalReturnGroup: {
        async findFirst({ where }) {
          reviewWhere = where;
          return null;
        },
      },
    },
  });
  assert.equal(reviewResult.status, 404);
  assert.deepEqual(reviewWhere, { id: "group_1", vendorStoreId: "store_b" });

  let addressWhere = null;
  const addressResult = await activateVendorReturnAddress({
    vendorStoreId: "store_b",
    draftId: "address_a",
    prismaClient: {
      vendorReturnAddress: {
        async findFirst({ where }) {
          addressWhere = where;
          return null;
        },
      },
    },
  });
  assert.equal(addressResult.status, 404);
  assert.deepEqual(addressWhere, {
    id: "address_a",
    vendorStoreId: "store_b",
    status: "DRAFT",
  });
});

test("buyer and store emails use readable copy and store notice excludes buyer PII", () => {
  const group = {
    id: "group_1",
    storeNameSnapshot: "テスト店舗",
    returnShippingPayer: "BUYER",
    withdrawalRequest: {
      id: "withdrawal_1",
      customerName: "購入者太郎",
      customerEmail: "buyer@example.com",
      shopifyOrderName: "#1010",
    },
  };
  const instruction = {
    addressSnapshotJson: {
      recipientName: "返品係",
      postalCode: "100-0001",
      countryLabel: "日本",
      region: "東京都",
      city: "千代田区",
      address1: "千代田1-1",
    },
    itemsSnapshotJson: [{ title: "商品A", quantity: 2 }],
    deadlineSnapshotJson: {
      operationalReturnDeadlineAt: "2026-07-31T00:00:00.000Z",
    },
  };
  const buyer = buildDirectReturnInstructionEmail({
    request: new Request("https://example.com/admin"),
    group,
    instruction,
    token: "secret",
  });
  const store = buildDirectReturnStoreNotificationEmail({ group, instruction });

  assert.match(buyer.subject, /返送方法のご案内/);
  assert.match(buyer.text, /店舗ごとに別の荷物/);
  assert.match(buyer.text, /通常配送方法に相当する初回送料/);
  assert.match(store.text, /商品A x 2/);
  assert.doesNotMatch(store.text, /buyer@example\.com/);
  assert.doesNotMatch(store.text, /購入者太郎/);
});
