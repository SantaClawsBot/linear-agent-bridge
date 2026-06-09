import assert from "node:assert/strict";
import test from "node:test";
import {
  addActiveRunSessionKey,
  cancelActiveRunsForIssue,
  clearActiveRunsForTesting,
  getActiveRun,
  isActiveRunCanceled,
  reapCanceledRuns,
  registerActiveRun,
  unregisterActiveRun,
} from "../dist/src/webhook/active-runs.js";

test("active runs can be canceled by issue id", () => {
  clearActiveRunsForTesting();
  registerActiveRun({
    issueId: "issue-1",
    sessionId: "session-1",
    apiToken: "token-1",
    sessionKeys: ["base-key"],
  });
  addActiveRunSessionKey("issue-1", "session-1", "exec-key");

  const canceled = cancelActiveRunsForIssue("issue-1", "delegate-unassigned");

  assert.deepEqual(canceled, [
    {
      issueId: "issue-1",
      sessionId: "session-1",
      apiToken: "token-1",
      sessionKeys: ["base-key", "exec-key"],
      reason: "delegate-unassigned",
    },
  ]);
  assert.equal(isActiveRunCanceled("issue-1", "session-1"), true);
});

test("unregistering active run clears canceled state", () => {
  clearActiveRunsForTesting();
  registerActiveRun({
    issueId: "issue-1",
    sessionId: "session-1",
    sessionKeys: ["base-key"],
  });
  cancelActiveRunsForIssue("issue-1", "delegate-unassigned");

  unregisterActiveRun("issue-1", "session-1");

  assert.equal(getActiveRun("issue-1", "session-1"), null);
  assert.equal(isActiveRunCanceled("issue-1", "session-1"), false);
});

test("a fresh cancel survives an immediate re-register (same-run protection)", () => {
  clearActiveRunsForTesting();
  registerActiveRun({ issueId: "issue-1", sessionId: "session-1", sessionKeys: ["k1"] });
  cancelActiveRunsForIssue("issue-1", "delegate-unassigned");
  // markCurrentRunActive() is called twice within one run; the second call must
  // NOT wipe a cancel that just targeted THIS run.
  registerActiveRun({ issueId: "issue-1", sessionId: "session-1", sessionKeys: ["k2"] });
  assert.equal(isActiveRunCanceled("issue-1", "session-1"), true);
});

test("reapCanceledRuns removes canceled records older than the max age", async () => {
  clearActiveRunsForTesting();
  registerActiveRun({ issueId: "issue-1", sessionId: "session-1", sessionKeys: ["k1"] });
  cancelActiveRunsForIssue("issue-1", "delegate-unassigned");
  await new Promise((r) => setTimeout(r, 5));
  // A genuine leftover (older than the threshold) is reaped; a live, non-canceled
  // record would be untouched because it has no canceledAt timestamp.
  const removed = reapCanceledRuns(1);
  assert.equal(removed, 1);
  assert.equal(getActiveRun("issue-1", "session-1"), null);
});
