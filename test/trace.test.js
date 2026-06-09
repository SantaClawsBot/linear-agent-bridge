import assert from "node:assert/strict";
import test from "node:test";
import { resolveTraceId, tracePrefix } from "../dist/src/webhook/trace.js";

test("resolveTraceId prefers Linear delivery id", () => {
  assert.equal(
    resolveTraceId({ webhookId: "webhook-1" }, "delivery-1", "session-1"),
    "delivery-1",
  );
});

test("resolveTraceId preserves a precomputed trace id", () => {
  assert.equal(
    resolveTraceId({ linearTraceId: "trace-1", webhookId: "webhook-1" }, "delivery-1", "session-1"),
    "trace-1",
  );
});

test("resolveTraceId falls back to webhook id then session id", () => {
  assert.equal(resolveTraceId({ webhookId: "webhook-1" }, undefined, "session-1"), "webhook-1");
  assert.equal(resolveTraceId({}, undefined, "session-1"), "session:session-1");
});

test("tracePrefix formats empty and present trace ids", () => {
  assert.equal(tracePrefix("delivery-1"), "[trace=delivery-1] ");
  assert.equal(tracePrefix(""), "");
});
