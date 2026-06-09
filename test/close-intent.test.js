import assert from "node:assert/strict";
import test from "node:test";
import { isCloseIntentPrompt } from "../dist/src/webhook/close-intent.js";

test("close-intent matches short imperative close commands", () => {
  assert.equal(isCloseIntentPrompt("close this issue"), true);
  assert.equal(isCloseIntentPrompt("close it"), true);
  assert.equal(isCloseIntentPrompt("please close the ticket"), true);
  assert.equal(isCloseIntentPrompt("mark it done"), true);
  assert.equal(isCloseIntentPrompt("закрой задачу"), true);
});

test("close-intent ignores incidental mentions and negations", () => {
  // The agent must not be bypassed by a sentence that merely contains "close".
  assert.equal(
    isCloseIntentPrompt("Before you close this issue, make sure the tests pass"),
    false,
  );
  assert.equal(isCloseIntentPrompt("the close button is broken on the issue page"), false);
  assert.equal(isCloseIntentPrompt("don't close the issue yet"), false);
  assert.equal(isCloseIntentPrompt("do not close this ticket"), false);
  assert.equal(isCloseIntentPrompt("не закрывай задачу"), false);
  assert.equal(isCloseIntentPrompt(""), false);
});
