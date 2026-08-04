import assert from "node:assert/strict";
import test from "node:test";

import {
  directReturnErrorMessage,
  getCompletionRecordBlockers,
  getQuickTransitionConfig,
  serializeWithdrawalRequest,
} from "../../app/services/withdrawalAdminDetail.js";

test("withdrawal admin direct-return errors keep their operator-facing copy", () => {
  assert.equal(
    directReturnErrorMessage("withdrawal_line_quantity_exceeded"),
    "購入数を超える撤回数量は指定できません。",
  );
  assert.equal(
    directReturnErrorMessage("unexpected"),
    "処理できませんでした: unexpected",
  );
});

test("withdrawal completion blockers preserve refund and return safeguards", () => {
  assert.deepEqual(
    getCompletionRecordBlockers(
      {
        refundDecisionStatus: "UNDECIDED",
        returnRequirementStatus: "WAITING",
      },
      "REFUNDED",
    ),
    [
      "返金判断が未記録です。完了前に返金判断を保存してください。",
      "返送が未完了です。返送不要または返送確認済みにしてから完了記録を保存してください。",
    ],
  );
});

test("withdrawal completion rejects a refunded result after a no-refund decision", () => {
  assert.deepEqual(
    getCompletionRecordBlockers(
      {
        refundDecisionStatus: "NO_REFUND",
        returnRequirementStatus: "NOT_REQUIRED",
      },
      "PARTIALLY_REFUNDED",
    ),
    [
      "返金なし判断の申請を返金済みとして完了できません。返金判断を見直してください。",
    ],
  );
});

test("withdrawal quick transitions keep their status and hidden inputs", () => {
  assert.deepEqual(getQuickTransitionConfig("no_return_refund_pending"), {
    label: "返送不要で返金判断へ",
    description: "返送不要として記録し、返金判断に進めます。",
    tone: "warning",
    toStatus: "REFUND_PENDING",
    reason: "管理画面の主要操作で返送不要として返金判断に進めました。",
    successMessage: "返送不要として返金判断に進めました。",
    returnInfo: true,
    hiddenInputs: [
      ["returnRequirementStatus", "NOT_REQUIRED"],
      ["returnConditionStatus", "NOT_APPLICABLE"],
    ],
  });
  assert.equal(getQuickTransitionConfig("unknown"), null);
});

test("withdrawal serialization preserves labels and converts dates", () => {
  const result = serializeWithdrawalRequest({
    id: "withdrawal_1",
    status: "REQUESTED",
    eligibilityStatus: "ELIGIBLE",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    statusHistory: [
      { id: "history_1", createdAt: new Date("2026-08-01T01:00:00.000Z") },
    ],
    emailLogs: [
      {
        id: "email_1",
        sentAt: new Date("2026-08-01T02:00:00.000Z"),
        createdAt: new Date("2026-08-01T01:30:00.000Z"),
      },
    ],
  });

  assert.equal(result.createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(result.updatedAt, "2026-08-02T00:00:00.000Z");
  assert.equal(result.statusHistory[0].createdAt, "2026-08-01T01:00:00.000Z");
  assert.equal(result.emailLogs[0].sentAt, "2026-08-01T02:00:00.000Z");
  assert.equal(typeof result.statusLabel, "string");
  assert.equal(typeof result.eligibilityLabel, "string");
});
