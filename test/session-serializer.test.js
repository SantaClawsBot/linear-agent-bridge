import assert from "node:assert/strict";
import test from "node:test";
import {
  runSerialized,
  getSerializerDepth,
  clearSerializerForTesting,
} from "../dist/src/webhook/session-serializer.js";

const api = { logger: { info() {}, warn() {} } };

test("serializer drops an exact duplicate delivery id", async () => {
  clearSerializerForTesting();
  let runs = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const run = async () => {
    runs += 1;
    await gate;
  };
  const data = { agentSessionId: "S", type: "AgentSessionEvent", action: "prompted" };
  const p1 = runSerialized(api, {}, data, "D1", run); // runs, awaits gate
  await runSerialized(api, {}, { ...data }, "D1", run); // same delivery id -> dropped
  assert.equal(runs, 1);
  release();
  await p1;
  assert.equal(runs, 1);
});

test("serializer queues a genuine fast follow-up (distinct delivery) instead of dropping it", async () => {
  clearSerializerForTesting();
  const order = [];
  let release1;
  const gate1 = new Promise((r) => {
    release1 = r;
  });
  // A real user follow-up sent moments after the run starts must NOT be lost.
  const mk = (id) => ({ agentSessionId: "S", type: "AgentSessionEvent", action: "prompted", _id: id });
  const run = async (_a, _c, d) => {
    order.push(`start:${d._id}`);
    if (d._id === 1) await gate1;
    order.push(`end:${d._id}`);
  };
  const p1 = runSerialized(api, {}, mk(1), "D1", run); // first prompted runs, awaits
  runSerialized(api, {}, mk(2), "D2", run); // distinct delivery -> QUEUED, not dropped
  assert.equal(getSerializerDepth("S"), 1);
  release1();
  await p1; // drains: finishes 1, then runs 2
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
});

test("serializer runs a session-less event directly", async () => {
  clearSerializerForTesting();
  let ran = false;
  await runSerialized(api, {}, { type: "AgentSessionEvent", action: "created" }, "D9", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("serializer never dedupes undefined delivery ids", async () => {
  clearSerializerForTesting();
  let runs = 0;
  // No session + undefined delivery: both must run (undefined is not a dedup key).
  await runSerialized(api, {}, { type: "X" }, undefined, async () => {
    runs += 1;
  });
  await runSerialized(api, {}, { type: "X" }, undefined, async () => {
    runs += 1;
  });
  assert.equal(runs, 2);
});
