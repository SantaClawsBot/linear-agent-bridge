import assert from "node:assert/strict";
import test from "node:test";
import {
  runSerialized,
  getSerializerDepth,
  clearSerializerForTesting,
} from "../dist/src/webhook/session-serializer.js";

const api = { logger: { info() {}, warn() {} } };

test("serializer drops a duplicate prompted within the dedup window", async () => {
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
  // type "Comment" maps to action "prompted"; agentSessionId provides the key.
  const data = { agentSessionId: "S", type: "Comment", action: "create" };
  const p1 = runSerialized(api, {}, data, undefined, run); // starts, awaits gate
  await runSerialized(api, {}, { ...data }, undefined, run); // duplicate -> dropped
  assert.equal(runs, 1);
  release();
  await p1;
  assert.equal(runs, 1);
});

test("serializer drops a duplicate created within the dedup window", async () => {
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
  const data = { agentSessionId: "S", type: "AgentSessionEvent", action: "created" };
  const p1 = runSerialized(api, {}, data, undefined, run); // starts, awaits gate
  await runSerialized(api, {}, { ...data }, undefined, run); // duplicate created -> dropped
  assert.equal(runs, 1);
  release();
  await p1;
  assert.equal(runs, 1);
});

test("serializer drops a prompted Comment-on-creation while a created is active", async () => {
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
  const created = { agentSessionId: "S", type: "AgentSessionEvent", action: "created" };
  const promptedComment = { agentSessionId: "S", type: "Comment", action: "create" };
  const p1 = runSerialized(api, {}, created, undefined, run); // created starts, awaits gate
  await runSerialized(api, {}, promptedComment, undefined, run); // Comment(prompted) within window -> dropped
  assert.equal(runs, 1);
  release();
  await p1;
  assert.equal(runs, 1);
});

test("serializer queues a different-action event and runs it after the first", async () => {
  clearSerializerForTesting();
  const order = [];
  let release1;
  const gate1 = new Promise((r) => {
    release1 = r;
  });
  // A genuine "created" racing a "prompted" Comment that started first must NOT
  // be dropped — it is queued and run after.
  const first = { agentSessionId: "S", type: "Comment", action: "create", _id: "p" };
  const second = { agentSessionId: "S", type: "AgentSessionEvent", action: "created", _id: "c" };
  const run = async (_a, _c, d) => {
    order.push(`start:${d._id}`);
    if (d._id === "p") await gate1;
    order.push(`end:${d._id}`);
  };
  const p1 = runSerialized(api, {}, first, undefined, run); // prompted starts, awaits gate1
  runSerialized(api, {}, second, undefined, run); // created -> queued (different action)
  assert.equal(getSerializerDepth("S"), 1);
  release1();
  await p1; // drains: finishes prompted, then runs created
  assert.deepEqual(order, ["start:p", "end:p", "start:c", "end:c"]);
});

test("serializer with no session id runs directly", async () => {
  clearSerializerForTesting();
  let ran = false;
  await runSerialized(api, {}, { type: "AgentSessionEvent", action: "created" }, undefined, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
