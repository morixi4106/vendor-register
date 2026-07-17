import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminContactNotification,
  buildContactAcknowledgement,
} from "../../app/services/contactInquiry.server.js";

test("public contact acknowledgement is fixed and does not promise a refund", () => {
  const message = buildContactAcknowledgement({ name: "テスト太郎" });

  assert.match(message, /お問い合わせを受け付けました/);
  assert.match(message, /対応を確約するものではありません/);
  assert.doesNotMatch(message, /返金します/);
});

test("admin contact notification contains the submitted contact details", () => {
  const message = buildAdminContactNotification({
    name: "テスト太郎",
    email: "buyer@example.com",
    phone: "090-0000-0000",
    message: "配送について確認したいです。",
    replyText: "受付確認本文",
  });

  assert.match(message, /受付確認（自動回答なし）/);
  assert.match(message, /buyer@example\.com/);
  assert.match(message, /配送について確認したいです/);
  assert.match(message, /受付確認本文/);
});
