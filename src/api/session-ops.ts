import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import {
  SESSION_UPDATE_MUTATION,
  AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
  AGENT_SESSION_CREATE_ON_COMMENT_MUTATION,
} from "../graphql/mutations.js";
import type { PlanStep } from "../types.js";
import { setPlan } from "../agent/plan-manager.js";
import { readObject, readString, readArray, sendJson } from "../util.js";

// POST /session/plan
registerApiHandler("/session/plan", async ({ api, cfg, context, body, res }) => {
  const rawPlan = readArray(body.plan);
  if (rawPlan.length === 0) {
    sendJson(res, 400, { ok: false, error: "plan array is required" });
    return;
  }

  const plan: PlanStep[] = rawPlan.map((item) => {
    const obj = readObject(item);
    return {
      content: readString(obj?.content) ?? "",
      status: (readString(obj?.status) ?? "pending") as PlanStep["status"],
    };
  });

  setPlan(context.sessionId, plan);

  const result = await callLinear(api, cfg, "agentSessionUpdate(plan)", {
    query: SESSION_UPDATE_MUTATION,
    variables: { id: context.sessionId, input: { plan } },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true });
});

// POST /session/create-on-issue
registerApiHandler("/session/create-on-issue", async ({ api, cfg, body, res }) => {
  const issueId = readString(body.issueId as string);
  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "agentSessionCreateOnIssue", {
    query: AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
    variables: { issueId },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.agentSessionCreateOnIssue);
  const session = readObject(root?.agentSession);
  sendJson(res, 200, {
    ok: root?.success === true,
    sessionId: readString(session?.id),
  });
});

// POST /session/create-on-comment
registerApiHandler("/session/create-on-comment", async ({ api, cfg, body, res }) => {
  const commentId = readString(body.commentId as string);
  if (!commentId) {
    sendJson(res, 400, { ok: false, error: "commentId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "agentSessionCreateOnComment", {
    query: AGENT_SESSION_CREATE_ON_COMMENT_MUTATION,
    variables: { commentId },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  const root = readObject(result.data!.agentSessionCreateOnComment);
  const session = readObject(root?.agentSession);
  sendJson(res, 200, {
    ok: root?.success === true,
    sessionId: readString(session?.id),
  });
});

// POST /session/external-url
registerApiHandler("/session/external-url", async ({ api, cfg, context, body, res }) => {
  const url = readString(body.url as string);
  const label = readString(body.label as string) ?? "Link";
  if (!url) {
    sendJson(res, 400, { ok: false, error: "url is required" });
    return;
  }

  const result = await callLinear(api, cfg, "agentSessionUpdate(externalUrl)", {
    query: SESSION_UPDATE_MUTATION,
    variables: {
      id: context.sessionId,
      input: { addedExternalUrls: [{ label, url }] },
    },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true });
});
