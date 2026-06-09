import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToken,
  getActiveSessionTokenCount,
  revokeSessionToken,
  sweepExpiredSessionTokens,
  validateSessionToken,
} from "../dist/src/agent/session-token.js";

function context() {
  return {
    sessionId: "session-1",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueUrl: "https://linear.app/acme/issue/ENG-1/test",
    teamId: "team-1",
    repoDir: "/tmp/repo",
    apiToken: "",
  };
}

test("session tokens expire after their TTL", () => {
  const token = createSessionToken(context(), {
    ttlMs: 100,
    now: () => 1_000,
  });

  assert.equal(validateSessionToken(token, { now: () => 1_050 })?.sessionId, "session-1");
  assert.equal(validateSessionToken(token, { now: () => 1_101 }), null);
});

test("expired session tokens can be swept", () => {
  const token = createSessionToken(context(), {
    ttlMs: 100,
    now: () => 2_000,
  });

  assert.equal(validateSessionToken(token, { now: () => 2_050 })?.issueId, "issue-1");
  assert.ok(getActiveSessionTokenCount(2_050) > 0);
  assert.equal(sweepExpiredSessionTokens(2_101), 1);
  assert.equal(validateSessionToken(token, { now: () => 2_101 }), null);
});

test("revoking a token removes it immediately", () => {
  const token = createSessionToken(context(), {
    ttlMs: 10_000,
    now: () => 3_000,
  });

  revokeSessionToken(token);

  assert.equal(validateSessionToken(token, { now: () => 3_001 }), null);
});
