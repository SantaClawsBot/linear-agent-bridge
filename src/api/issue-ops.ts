import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import {
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  ISSUE_RELATION_CREATE_MUTATION,
} from "../graphql/mutations.js";
import { readObject, readString, sendJson } from "../util.js";
import { resolveCompletedState, resolveIssueInfo } from "../webhook/issue-policy.js";

// POST /issue/create
registerApiHandler("/issue/create", async ({ api, cfg, context, body, res }) => {
  const input: Record<string, unknown> = {
    teamId: readString(body.teamId as string) || context.teamId,
    title: readString(body.title as string) ?? "",
  };
  if (body.description) input.description = body.description;
  if (typeof body.priority === "number") input.priority = body.priority;
  if (Array.isArray(body.labelIds)) input.labelIds = body.labelIds;
  if (body.assigneeId) input.assigneeId = body.assigneeId;
  if (body.parentId) input.parentId = body.parentId;
  if (body.stateId) input.stateId = body.stateId;

  if (!input.title) {
    sendJson(res, 400, { ok: false, error: "title is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issueCreate", {
    query: ISSUE_CREATE_MUTATION,
    variables: { input },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueCreate);
  sendJson(res, 200, { ok: root?.success === true, data: root });
});

// POST /issue/update
registerApiHandler("/issue/update", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }

  const input: Record<string, unknown> = {};
  if (body.title !== undefined) input.title = body.title;
  if (body.description !== undefined) input.description = body.description;
  if (body.stateId !== undefined) input.stateId = body.stateId;
  if (typeof body.priority === "number") input.priority = body.priority;
  if (Array.isArray(body.labelIds)) input.labelIds = body.labelIds;
  if (body.assigneeId !== undefined) input.assigneeId = body.assigneeId;
  if (body.delegateId !== undefined) input.delegateId = body.delegateId;

  const result = await callLinear(api, cfg, "issueUpdate", {
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: issueId, input },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueUpdate);
  sendJson(res, 200, { ok: root?.success === true, data: root });
});

// POST /issue/close
registerApiHandler("/issue/close", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }

  const info = await resolveIssueInfo(api, cfg, issueId);
  if (!info) {
    sendJson(res, 404, { ok: false, error: "Issue not found" });
    return;
  }
  if (info.stateType === "completed" || info.stateType === "canceled") {
    sendJson(res, 200, { ok: true, alreadyClosed: true });
    return;
  }
  if (!info.teamId) {
    sendJson(res, 400, { ok: false, error: "Cannot determine team" });
    return;
  }
  const stateId = await resolveCompletedState(api, cfg, info.teamId);
  if (!stateId) {
    sendJson(res, 400, { ok: false, error: "No completed state found" });
    return;
  }

  const result = await callLinear(api, cfg, "issueUpdate(close)", {
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: issueId, input: { stateId } },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueUpdate);
  sendJson(res, 200, { ok: root?.success === true });
});

// POST /issue/create-sub-issue
registerApiHandler("/issue/create-sub-issue", async ({ api, cfg, context, body, res }) => {
  const parentId = readString(body.parentId as string) || context.issueId;
  if (!parentId) {
    sendJson(res, 400, { ok: false, error: "parentId is required" });
    return;
  }

  const input: Record<string, unknown> = {
    teamId: readString(body.teamId as string) || context.teamId,
    title: readString(body.title as string) ?? "",
    parentId,
  };
  if (body.description) input.description = body.description;
  if (typeof body.priority === "number") input.priority = body.priority;
  if (Array.isArray(body.labelIds)) input.labelIds = body.labelIds;
  if (body.assigneeId) input.assigneeId = body.assigneeId;

  if (!input.title) {
    sendJson(res, 400, { ok: false, error: "title is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issueCreate(sub)", {
    query: ISSUE_CREATE_MUTATION,
    variables: { input },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueCreate);
  sendJson(res, 200, { ok: root?.success === true, data: root });
});

// POST /issue/link
registerApiHandler("/issue/link", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  const relatedIssueId = readString(body.relatedIssueId as string);
  const type = readString(body.type as string);

  if (!issueId || !relatedIssueId) {
    sendJson(res, 400, { ok: false, error: "issueId and relatedIssueId are required" });
    return;
  }
  if (!type || !["blocks", "blocked_by", "related", "duplicate"].includes(type)) {
    sendJson(res, 400, {
      ok: false,
      error: "type must be one of: blocks, blocked_by, related, duplicate",
    });
    return;
  }

  const result = await callLinear(api, cfg, "issueRelationCreate", {
    query: ISSUE_RELATION_CREATE_MUTATION,
    variables: { input: { issueId, relatedIssueId, type } },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.issueRelationCreate);
  sendJson(res, 200, { ok: root?.success === true, data: root });
});
