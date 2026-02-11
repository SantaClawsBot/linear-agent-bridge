import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import { ISSUE_UPDATE_MUTATION } from "../graphql/mutations.js";
import { readObject, readString, sendJson } from "../util.js";

// POST /delegate/assign
registerApiHandler("/delegate/assign", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  const delegateId = readString(body.delegateId as string);

  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }
  if (!delegateId) {
    sendJson(res, 400, { ok: false, error: "delegateId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issueUpdate(delegate)", {
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: issueId, input: { delegateId } },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueUpdate);
  sendJson(res, 200, { ok: root?.success === true });
});

// POST /delegate/reassign
registerApiHandler("/delegate/reassign", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  const assigneeId = readString(body.assigneeId as string);

  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }
  if (!assigneeId) {
    sendJson(res, 400, { ok: false, error: "assigneeId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issueUpdate(assignee)", {
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: issueId, input: { assigneeId } },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueUpdate);
  sendJson(res, 200, { ok: root?.success === true });
});
