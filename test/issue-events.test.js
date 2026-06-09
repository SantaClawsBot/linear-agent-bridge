import assert from "node:assert/strict";
import test from "node:test";
import { resolveDelegateUnassignment } from "../dist/src/webhook/issue-events.js";

test("detects when an Issue update removes this app as delegate", () => {
  assert.deepEqual(
    resolveDelegateUnassignment(
      {
        type: "Issue",
        action: "update",
        id: "issue-1",
        delegateId: null,
        updatedFrom: { delegateId: "app-1" },
      },
      "app-1",
    ),
    {
      issueId: "issue-1",
      previousDelegateId: "app-1",
      currentDelegateId: "",
    },
  );
});

test("detects when a nested delegate changes away from this app", () => {
  assert.deepEqual(
    resolveDelegateUnassignment(
      {
        type: "Issue",
        action: "update",
        id: "issue-1",
        delegate: { id: "other-app" },
        updatedFrom: { delegate: { id: "app-1" } },
      },
      "app-1",
    ),
    {
      issueId: "issue-1",
      previousDelegateId: "app-1",
      currentDelegateId: "other-app",
    },
  );
});

test("ignores Issue updates that do not change delegate away from this app", () => {
  assert.equal(
    resolveDelegateUnassignment(
      {
        type: "Issue",
        action: "update",
        id: "issue-1",
        delegateId: "app-1",
        updatedFrom: { title: "Old title" },
      },
      "app-1",
    ),
    null,
  );
  assert.equal(
    resolveDelegateUnassignment(
      {
        type: "Issue",
        action: "update",
        id: "issue-1",
        delegateId: "other-app",
        updatedFrom: { delegateId: "another-app" },
      },
      "app-1",
    ),
    null,
  );
});
