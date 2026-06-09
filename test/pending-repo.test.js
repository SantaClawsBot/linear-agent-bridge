import assert from "node:assert/strict";
import test from "node:test";
import {
  setPendingRepo,
  hasPendingRepo,
  takePendingRepo,
  clearPendingRepo,
  isAffirmativeRepoAnswer,
} from "../dist/src/webhook/pending-repo.js";

test("pending repo can be set, observed, and consumed once", () => {
  clearPendingRepo("s1");
  assert.equal(hasPendingRepo("s1"), false);
  setPendingRepo("s1", { dir: "/repo", repoName: "org/repo" });
  assert.equal(hasPendingRepo("s1"), true);
  assert.deepEqual(takePendingRepo("s1"), { dir: "/repo", repoName: "org/repo" });
  // Consumed — gone now.
  assert.equal(hasPendingRepo("s1"), false);
  assert.equal(takePendingRepo("s1"), undefined);
});

test("affirmative repo answers are distinguished from negatives", () => {
  assert.equal(isAffirmativeRepoAnswer("yes"), true);
  assert.equal(isAffirmativeRepoAnswer("Yes, use org/repo"), true);
  assert.equal(isAffirmativeRepoAnswer("use it"), true);
  assert.equal(isAffirmativeRepoAnswer("да"), true);
  assert.equal(isAffirmativeRepoAnswer("no"), false);
  assert.equal(isAffirmativeRepoAnswer("No, let me specify a different repo"), false);
  assert.equal(isAffirmativeRepoAnswer("нет"), false);
  assert.equal(isAffirmativeRepoAnswer(""), false);
});
