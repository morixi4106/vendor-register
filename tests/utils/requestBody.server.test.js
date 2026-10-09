import assert from "node:assert/strict";
import test from "node:test";
import {
  readBoundedFormData,
  readBoundedRequestBody,
} from "../../app/utils/requestBody.server.js";

test("body limit counts real UTF-8 bytes without trusting Content-Length", async () => {
  const request = new Request("https://test.example/", {
    method: "POST",
    body: "ああ",
    headers: { "Content-Length": "1" },
  });
  await assert.rejects(
    readBoundedRequestBody(request, 5),
    (error) => error instanceof Response && error.status === 413,
  );
});

test("bounded form parser retains standard form semantics", async () => {
  const request = new Request("https://test.example/", {
    method: "POST",
    body: new URLSearchParams({ email: "test@example.com", name: "名前" }),
  });
  const form = await readBoundedFormData(request);
  assert.equal(form.get("email"), "test@example.com");
  assert.equal(form.get("name"), "名前");
});
