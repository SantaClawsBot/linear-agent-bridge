import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSessionAppUserFromPayload,
  resolveSessionId,
} from "../dist/src/webhook/session-resolver.js";

test("resolveSessionId reads the session id directly from AgentSessionEvent payloads", () => {
  // created: nested agentSession object
  assert.equal(
    resolveSessionId({ type: "AgentSessionEvent", agentSession: { id: "s1" } }),
    "s1",
  );
  // prompted follow-up: the activity carries the session id
  assert.equal(
    resolveSessionId({ type: "AgentSessionEvent", agentActivity: { agentSessionId: "s2" } }),
    "s2",
  );
  // flat string field
  assert.equal(resolveSessionId({ agentSessionId: "s3" }), "s3");
  // nothing to resolve (e.g. an Issue webhook with no agent session)
  assert.equal(resolveSessionId({ type: "Issue", id: "i1" }), "");
});

test("resolveSessionAppUserFromPayload reads top-level appUserId", () => {
  assert.equal(
    resolveSessionAppUserFromPayload({
      appUserId: "app-1",
      agentSession: { id: "session-1" },
    }),
    "app-1",
  );
});

test("resolveSessionAppUserFromPayload reads nested agentSession.appUser.id", () => {
  assert.equal(
    resolveSessionAppUserFromPayload({
      agentSession: { id: "s1", appUser: { id: "app-2" } },
    }),
    "app-2",
  );
});
