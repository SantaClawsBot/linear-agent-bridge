import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionHintStore,
  pickSessionIdFromComment,
  resolveSessionAppUserFromPayload,
} from "../dist/src/webhook/session-resolver.js";

test("session hint store expires cached comment references", () => {
  let now = 1_000;
  const store = createSessionHintStore({ ttlMs: 100, now: () => now });
  store.remember(
    {
      type: "Comment",
      comment: { id: "comment-1", issueId: "issue-1" },
    },
    "session-1",
  );

  assert.equal(
    store.resolveCachedCommentSession({
      type: "Comment",
      comment: { id: "comment-1", issueId: "issue-1" },
    }),
    "session-1",
  );

  now = 1_101;

  assert.equal(
    store.resolveCachedCommentSession({
      type: "Comment",
      comment: { id: "comment-1", issueId: "issue-1" },
    }),
    "",
  );
  assert.deepEqual(store.size(), { issues: 0, comments: 0 });
});

test("session hint store does not route unrelated comments by issue id", () => {
  const store = createSessionHintStore({ ttlMs: 10_000, now: () => 1_000 });
  store.remember(
    {
      type: "AgentSessionEvent",
      agentSession: { id: "session-1", issue: { id: "issue-1" } },
    },
    "session-1",
  );

  assert.equal(
    store.resolveCachedCommentSession({
      type: "Comment",
      comment: { id: "comment-2", issueId: "issue-1" },
    }),
    "",
  );
});

test("session hint store keeps thread parent mappings for direct replies", () => {
  const store = createSessionHintStore({ ttlMs: 10_000, now: () => 1_000 });
  store.remember(
    {
      type: "Comment",
      comment: { id: "comment-1", parentId: "root-1", issueId: "issue-1" },
    },
    "session-1",
  );

  assert.equal(
    store.resolveCachedCommentSession({
      type: "Comment",
      comment: { id: "comment-2", parentId: "root-1", issueId: "issue-1" },
    }),
    "session-1",
  );
});

test("pickSessionIdFromComment filters mixed ownership sessions", () => {
  const comment = {
    agentSessions: {
      nodes: [
        { id: "other-session", appUser: { id: "other-app" } },
        { id: "our-session", appUser: { id: "our-app" } },
      ],
    },
  };

  assert.equal(pickSessionIdFromComment(comment, "our-app"), "our-session");
});

test("pickSessionIdFromComment keeps backward compatibility when appUser is absent", () => {
  const comment = {
    agentSession: { id: "legacy-session" },
  };

  assert.equal(pickSessionIdFromComment(comment, "our-app"), "legacy-session");
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
