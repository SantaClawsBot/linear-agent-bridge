import { registerApiHandler } from "./router.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import {
  ISSUE_DETAIL_QUERY,
  TEAM_DETAIL_QUERY,
  REPO_SUGGESTIONS_QUERY,
} from "../graphql/queries.js";
import { readObject, readString, readArray, sendJson } from "../util.js";

// POST /query/issue
registerApiHandler("/query/issue", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issue(detail)", {
    query: ISSUE_DETAIL_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true, data: result.data!.issue });
});

// POST /query/team
registerApiHandler("/query/team", async ({ api, cfg, context, body, res }) => {
  const teamId = readString(body.teamId as string) || context.teamId;
  if (!teamId) {
    sendJson(res, 400, { ok: false, error: "teamId is required" });
    return;
  }

  const result = await callLinear(api, cfg, "team(detail)", {
    query: TEAM_DETAIL_QUERY,
    variables: { id: teamId },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true, data: result.data!.team });
});

// POST /query/repo-suggestions
registerApiHandler("/query/repo-suggestions", async ({ api, cfg, context, body, res }) => {
  const issueId = readString(body.issueId as string) || context.issueId;
  const candidates = readArray(body.candidateRepositories);

  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }
  if (candidates.length === 0) {
    sendJson(res, 400, { ok: false, error: "candidateRepositories is required" });
    return;
  }

  const result = await callLinear(api, cfg, "issueRepositorySuggestions", {
    query: REPO_SUGGESTIONS_QUERY,
    variables: {
      issueId,
      agentSessionId: context.sessionId,
      candidateRepositories: candidates,
    },
  });
  if (!result.ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: result.data!.issueRepositorySuggestions,
  });
});

// POST /query/viewer
registerApiHandler("/query/viewer", async ({ api, cfg, res }) => {
  const id = await resolveViewer(api, cfg);
  if (!id) {
    sendJson(res, 502, { ok: false, error: "Could not resolve viewer" });
    return;
  }
  sendJson(res, 200, { ok: true, data: { id } });
});
