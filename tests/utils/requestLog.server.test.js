import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createSafeRequestLogger,
  getSanitizedRequestPath,
} from "../../app/utils/requestLog.server.js";

test("request log paths remove every query parameter", () => {
  const path = getSanitizedRequestPath(
    "/app/production-readiness?embedded=1&id_token=secret&hmac=hash&session=session-id",
  );

  assert.equal(path, "/app/production-readiness");
  assert.doesNotMatch(path, /secret|hash|session-id/);
});

test("request log paths remove control characters from malformed input", () => {
  const path = getSanitizedRequestPath(
    "/app/production-readiness\r\nforged-log?id_token=secret",
  );

  assert.equal(path, "/app/production-readinessforged-log");
  assert.doesNotMatch(path, /[\r\n]|secret/);
});

test("safe request logging never emits the query string", () => {
  const messages = [];
  const response = new EventEmitter();
  response.statusCode = 200;
  response.getHeader = () => "123";
  const logger = createSafeRequestLogger({
    log: (message) => messages.push(message),
  });
  let nextCalled = false;

  logger(
    {
      method: "GET",
      originalUrl:
        "/app/production-readiness?id_token=secret&hmac=hash&shop=example.myshopify.com",
    },
    response,
    () => {
      nextCalled = true;
    },
  );
  response.emit("finish");

  assert.equal(nextCalled, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^GET \/app\/production-readiness 200 123 - /);
  assert.doesNotMatch(messages[0], /secret|hash|myshopify/);
});
