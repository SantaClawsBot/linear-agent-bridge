/**
 * GitHub webhook handler for PR review events.
 *
 * Receives GitHub webhooks (pull_request_review_comment,
 * pull_request_review, issue_comment on PRs), extracts the
 * Linear issue key from the branch name (e.g. "linear/PRO-79-foo"
 * → "PRO-79"), resolves the existing Linear agent session, and
 * dispatches the agent with enriched PR context so it can push
 * commits responding to review feedback.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { normalizeCfg } from "../config.js";
import { readBody, readString, readObject, sendJson } from "../util.js";
import { verifyGitHubSignature } from "./github-validation.js";
import { createSessionToken, revokeSessionToken } from "../agent/session-token.js";
import { buildEnrichedMessage } from "../agent/context-builder.js";
import { hasPostedResponse, clearResponseFlag } from "../agent/response-tracker.js";
import { cleanupSession } from "../agent/plan-manager.js";
import { callLinear } from "../linear-client.js";

const MAX_BODY = 2 * 1024 * 1024;
const BRANCH_RE = /linear\/([A-Z]+-[0-9]+)/i;

export function createGitHubWebhook(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }
    const raw = read.body;
    const cfg = normalizeCfg(api.pluginConfig);
    const secret = cfg.githubWebhookSecret;

    if (secret) {
      const sig = req.headers["x-hub-signature-256"];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      if (!sigStr || !verifyGitHubSignature(secret, sigStr, raw)) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    // Capture the GitHub event type
    const ghEvent = req.headers["x-github-event"];
    const eventStr = Array.isArray(ghEvent) ? ghEvent[0] : (ghEvent ?? "");

    const text = raw.toString("utf8");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    // Respond immediately, process async
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));

    queueMicrotask(() => {
      processGitHubEvent(api, cfg, payload, eventStr).catch((err) => {
        api.logger.warn?.(
          `github webhook error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  };
}

async function processGitHubEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
  event: string,
): Promise<void> {
  const action = readString(payload.action) ?? "";

  // We only care about review comments, review submissions, and PR comments
  if (!isRelevantEvent(event, action, payload)) {
    api.logger.info?.(`github webhook ignored (event=${event} action=${action})`);
    return;
  }

  // Skip bot/self comments
  const sender = readObject(payload.sender);
  const senderLogin = readString(sender?.login) ?? "";
  const senderType = readString(sender?.type) ?? "";
  if (senderType === "Bot") {
    api.logger.info?.(`github webhook ignored (bot: ${senderLogin})`);
    return;
  }

  // Extract PR info
  const pr = readObject(payload.pull_request) ?? readObject(payload.issue);
  if (!pr) {
    api.logger.info?.("github webhook ignored (no pull_request/issue)");
    return;
  }

  // For issue_comment, only process if the issue is a PR
  const isPR = !!readObject(payload.pull_request);
  if (!isPR) {
    const prField = readObject((pr as Record<string, unknown>).pull_request);
    if (!prField) {
      api.logger.info?.("github webhook ignored (issue_comment on non-PR issue)");
      return;
    }
  }

  const head = readObject((pr as Record<string, unknown>).head);
  const refName = readString(head?.ref) ?? "";
  const match = BRANCH_RE.exec(refName);
  if (!match) {
    api.logger.info?.(`github webhook ignored (branch "${refName}" has no linear/ prefix)`);
    return;
  }

  const issueIdentifier = match[1].toUpperCase(); // e.g. "PRO-79"
  api.logger.info?.(
    `github webhook: PR review on branch ${refName} → ${issueIdentifier} (event=${event}, action=${action}, sender=${senderLogin})`,
  );

  // Resolve the Linear issue to get issueId and context
  const issueData = await resolveLinearIssue(api, cfg, issueIdentifier);
  if (!issueData) {
    api.logger.warn?.(`github: could not resolve Linear issue ${issueIdentifier}`);
    return;
  }

  const { issueId, title, url: issueUrl, description, teamId } = issueData;

  // Find the most recent agent session for this issue
  const session = await findSessionForIssue(api, cfg, issueId);
  if (!session) {
    api.logger.warn?.(`github: no active agent session for ${issueIdentifier}, skipping`);
    return;
  }

  // Build the prompt from the GitHub event
  const prHtmlUrl = readString((pr as Record<string, unknown>).html_url) ?? "";
  const prNumber = String((pr as Record<string, unknown>).number ?? "");
  const prompt = buildGitHubPrompt(payload, event, action, {
    issueIdentifier,
    title,
    prNumber,
    prUrl: prHtmlUrl,
    refName,
    senderLogin,
  });

  if (!prompt) {
    api.logger.info?.("github webhook ignored (empty prompt)");
    return;
  }

  // Resolve repo dir
  const repo = cfg.defaultDir ?? "";

  // Post a thought activity to Linear
  const { postActivity } = await import("./handler.js");
  postActivity(api, cfg, session, {
    type: "thought",
    body: `📥 GitHub PR review feedback received from @${senderLogin} on #${prNumber}`,
  }, { ephemeral: true }).catch(() => {});

  // Generate API token for the agent
  const enableApi = cfg.enableAgentApi !== false;
  let apiToken = "";
  if (enableApi) {
    const sessionCtx = {
      sessionId: session,
      issueId,
      issueIdentifier,
      issueTitle: title,
      issueUrl,
      teamId,
      repoDir: repo,
      apiToken: "",
    };
    apiToken = createSessionToken(sessionCtx);
    sessionCtx.apiToken = apiToken;
  }

  // Build enriched message
  let message: string;
  if (enableApi && apiToken) {
    const { getBaseUrl } = await import("../api/base-url.js");
    const apiBaseUrl = cfg.apiBaseUrl || getBaseUrl();
    message = buildEnrichedMessage({
      action: "prompted",
      id: issueIdentifier,
      title,
      url: issueUrl,
      desc: description ?? "",
      guidance: "",
      prompt,
      repo,
      session,
      context: "",
      compact: false,
      apiBaseUrl,
      apiToken,
      issueId,
      teamId,
      repoDir: repo,
    });
  } else {
    const { buildMessage } = await import("./message-builder.js");
    message = buildMessage({
      action: "prompted",
      id: issueIdentifier,
      title,
      url: issueUrl,
      desc: description ?? "",
      guidance: "",
      prompt,
      repo,
      session,
      context: "",
      compact: false,
    });
  }

  // Dispatch through the concurrency-limited agent pipeline
  const { enqueueAgentRun } = await import("./concurrency.js");
  const agent = cfg.devAgentId ?? "dev";

  enqueueAgentRun(api, cfg, {
    agentSessionId: session,
    issueId,
    issueIdentifier,
    _ghMessage: message,
    _ghAgent: agent,
    _ghSession: session,
  }, undefined, async (_api, _cfg, _data, _delivery) => {
    const label = `[GitHub PR] ${issueIdentifier}: ${title}`;
    let agentResult: unknown;

    try {
      const { dispatchToAgentRuntime } = await import("./handler.js");
      agentResult = await dispatchToAgentRuntime(api, {
        message,
        agentId: agent,
        sessionKey: `agent:${agent}:linear:github:${issueIdentifier.toLowerCase()}`,
        label,
      });
    } catch (dispatchErr) {
      api.logger.warn?.(`github: agent dispatch failed: ${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)}`);
      if (apiToken) revokeSessionToken(apiToken);
      cleanupSession(session);
      return;
    }

    if (apiToken) revokeSessionToken(apiToken);
    cleanupSession(session);

    if (hasPostedResponse(session)) {
      clearResponseFlag(session);
      return;
    }

    const { buildAgentResponse } = await import("./response-parser.js");
    const text = buildAgentResponse(agentResult);
    if (!text || text === "Agent completed with no reply.") return;

    postActivity(api, cfg, session, { type: "response", body: text }).catch(() => {});
  });
}

// --- Helpers ---

function isRelevantEvent(
  event: string,
  action: string,
  _payload: Record<string, unknown>,
): boolean {
  switch (event) {
    case "pull_request_review_comment":
      return action === "created" || action === "edited";
    case "pull_request_review":
      return action === "submitted";
    case "issue_comment":
      return action === "created" || action === "edited";
    default:
      return false;
  }
}

function buildGitHubPrompt(
  payload: Record<string, unknown>,
  event: string,
  action: string,
  ctx: {
    issueIdentifier: string;
    title: string;
    prNumber: string;
    prUrl: string;
    refName: string;
    senderLogin: string;
  },
): string {
  const parts: string[] = [];

  parts.push("## GitHub PR Review Feedback");
  parts.push(`**PR:** #${ctx.prNumber} — ${ctx.prUrl}`);
  parts.push(`**Branch:** \`${ctx.refName}\``);
  parts.push(`**From:** @${ctx.senderLogin}`);
  parts.push(`**Event:** ${event} (${action})`);

  if (event === "pull_request_review_comment") {
    const comment = readObject(payload.comment);
    const body = readString(comment?.body) ?? "";
    const path = readString(comment?.path) ?? "";
    const line = String((comment as Record<string, unknown>)?.line ?? "");
    const diffHunk = readString(comment?.diff_hunk) ?? "";

    if (path) {
      parts.push(`**File:** \`${path}${line ? `:${line}` : ""}\``);
    }
    if (diffHunk) {
      parts.push(`**Diff context:**\n\`\`\`diff\n${diffHunk}\n\`\`\``);
    }
    if (body) {
      parts.push(`**Comment:**\n${body}`);
    }
  } else if (event === "pull_request_review") {
    const review = readObject(payload.review) ?? readObject(payload.pull_request_review);
    const body = readString(review?.body) ?? "";
    const state = readString(review?.state) ?? "";
    const comments = (review?.pull_request_review_comments ?? (review as Record<string, unknown>)?.comments) as unknown[];

    if (state) {
      const stateLabel: Record<string, string> = {
        approved: "✅ Approved",
        changes_requested: "🔴 Changes Requested",
        commented: "💬 Commented",
      };
      parts.push(`**Review state:** ${stateLabel[state] ?? state}`);
    }
    if (body) {
      parts.push(`**Review summary:**\n${body}`);
    }
    if (Array.isArray(comments) && comments.length > 0) {
      parts.push("**Inline comments:**");
      for (const c of comments) {
        const obj = readObject(c as Record<string, unknown>);
        if (!obj) continue;
        const cPath = readString(obj.path) ?? "";
        const cLine = String(obj.line ?? "");
        const cBody = readString(obj.body) ?? "";
        parts.push(`- \`${cPath}${cLine ? `:${cLine}` : ""}\`: ${cBody}`);
      }
    }
  } else if (event === "issue_comment") {
    const comment = readObject(payload.comment);
    const body = readString(comment?.body) ?? "";
    if (body) {
      parts.push(`**Comment:**\n${body}`);
    }
  }

  parts.push("");
  parts.push(
    `Please address this feedback. The working directory is already checked out on branch \`${ctx.refName}\`.`,
  );
  parts.push(
    "Make the necessary code changes, commit them, and push. Then post a summary of what you changed.",
  );

  return parts.join("\n\n");
}

async function resolveLinearIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  identifier: string,
): Promise<{
  issueId: string;
  title: string;
  url: string;
  description: string;
  teamId: string;
} | null> {
  const { ISSUE_BY_IDENTIFIER_QUERY } = await import("../graphql/queries.js");
  const result = await callLinear(api, cfg, "issueByIdentifier", {
    query: ISSUE_BY_IDENTIFIER_QUERY,
    variables: { identifier },
  });
  if (!result.ok) return null;
  const data = result.data as Record<string, unknown>;
  const issues = readObject(data.issues);
  const nodes = (issues?.nodes as unknown[]) ?? [];
  if (nodes.length === 0) return null;
  const issue = readObject(nodes[0] as Record<string, unknown>);
  if (!issue) return null;
  const team = readObject(issue.team);
  return {
    issueId: readString(issue.id) ?? "",
    title: readString(issue.title) ?? "",
    url: readString(issue.url) ?? "",
    description: readString(issue.description) ?? "",
    teamId: readString(team?.id) ?? "",
  };
}

async function findSessionForIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<string> {
  const { ISSUE_SESSION_QUERY } = await import("../graphql/queries.js");
  const result = await callLinear(api, cfg, "issue(session)", {
    query: ISSUE_SESSION_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return "";
  const issue = readObject(result.data?.issue);
  const comments = readObject(issue?.comments);
  const nodes = (comments?.nodes as unknown[]) ?? [];

  // Walk comments in reverse to find the most recent session
  for (let i = nodes.length - 1; i >= 0; i--) {
    const comment = readObject(nodes[i] as Record<string, unknown>);
    if (!comment) continue;
    const session = readObject(comment.agentSession);
    const sid = readString(session?.id);
    if (sid) return sid;
    const sessions = readObject(comment.agentSessions);
    const sNodes = (sessions?.nodes as unknown[]) ?? [];
    for (const entry of sNodes) {
      const id = readString(readObject(entry as Record<string, unknown>)?.id);
      if (id) return id;
    }
  }
  return "";
}
