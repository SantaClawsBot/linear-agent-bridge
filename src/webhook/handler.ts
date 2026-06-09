import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  OpenClawPluginApi,
  PluginConfig,
  ActivityContent,
  ActivityOptions,
} from "../types.js";
import { normalizeCfg } from "../config.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import { ACTIVITY_MUTATION, SESSION_UPDATE_MUTATION } from "../graphql/mutations.js";
import {
  readBody,
  readHeader,
  readObject,
  readString,
  normalizeKey,
  sendJson,
  resolveFlag,
} from "../util.js";
import { verifySignature } from "./validation.js";
import {
  resolveSessionId,
  resolveOwnedSessionId,
  resolveIssue,
} from "./session-resolver.js";
import {
  buildMessage,
  buildLabel,
  buildThought,
  buildStopText,
  resolveAction,
  resolvePrompt,
  resolveSignal,
  resolveContext,
  resolveGuidance,
  resolveKey,
  resolveRepo,
  resolveExternal,
} from "./message-builder.js";
import { buildAgentResponse } from "./response-parser.js";
import { applyIssuePolicy, resolveReviewState, resolveIssueInfo, updateIssue } from "./issue-policy.js";
import { isCloseIntentPrompt, closeIssueFromPrompt } from "./close-intent.js";
import { resolveRepoWithOrg } from "./repo-resolver.js";
import {
  hasPendingRepo,
  takePendingRepo,
  setPendingRepo,
  isAffirmativeRepoAnswer,
} from "./pending-repo.js";
import { shouldSkipPromptedRun, isSelfAuthoredComment } from "./skip-filter.js";
import { createSessionToken, revokeSessionToken } from "../agent/session-token.js";
import { buildEnrichedMessage } from "../agent/context-builder.js";
import { cleanupSession } from "../agent/plan-manager.js";
import { hasPostedResponse, clearResponseFlag } from "../agent/response-tracker.js";
import { captureBaseUrl } from "../api/base-url.js";
import { resolveTraceId, tracePrefix } from "./trace.js";
import {
  addActiveRunSessionKey,
  cancelActiveRunsForIssue,
  isActiveRunCanceled,
  registerActiveRun,
  unregisterActiveRun,
} from "./active-runs.js";
import { resolveDelegateUnassignment } from "./issue-events.js";

const callRef: { value?: (opts: Record<string, unknown>) => Promise<unknown> } = {};

async function autoCloseIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<void> {
  if (!issueId) return;
  try {
    const info = await resolveIssueInfo(api, cfg, issueId);
    if (!info) return;
    if (info.stateType === "completed" || info.stateType === "canceled") return;
    if (!info.teamId) return;
    const stateId = await resolveReviewState(api, cfg, info.teamId);
    if (!stateId) {
      api.logger.info?.(
        `linear: closeOnComplete found no "review" workflow state for team; leaving issue ${issueId.slice(0, 8)}... unchanged`,
      );
      return;
    }
    const ok = await updateIssue(api, cfg, info.id, { stateId }, "issueUpdate(autoClose)");
    if (ok) {
      api.logger.info?.(`linear: auto-moved issue to review ${issueId.slice(0, 8)}...`);
    } else {
      api.logger.warn?.(`linear: failed to auto-move issue to review ${issueId.slice(0, 8)}...`);
    }
  } catch (err) {
    api.logger.warn?.(`linear: error auto-moving issue to review: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const MAX_BODY = 2 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

// Multi-phase dispatch: split work across sequential agent runs
// to avoid context overflow on complex issues.
const PHASE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per phase

const PHASE_PLAN_PROMPT_SUFFIX = [
  "",
  "---",
  "## INSTRUCTIONS — PLANNING PHASE",
  "",
  "You are in the PLANNING phase. Your job is to investigate the issue and produce a concrete implementation plan.",
  "",
  "1. Read relevant files to understand the codebase.",
  "2. Identify exactly which files need to change and how.",
  "3. Output a plan as a structured markdown block.",
  "",
  "IMPORTANT: When you are done, call the activity/action action with your plan. Do NOT implement anything yet. Do NOT use activity/response — that ends the session prematurely.",
  "Your plan will be handed to a fresh agent session for implementation.",
  "",
  "Use this format for your response:",
  "```markdown",
  "## Implementation Plan",
  "### Files to modify",
  "- `path/to/file.ts` — description of change",
  "### Files to create  ",
  "- `path/to/new-file.ts` — description",
  "### Implementation steps",
  "1. Step one (with enough detail that another agent can execute it)",
  "2. Step two",
  "...",
  "### Testing",
  "- How to verify the changes work",
  "```",
].join("\n");

function buildExecPhaseMessage(
  plan: string,
  compact: boolean,
  creds?: { apiToken: string; apiBaseUrl: string },
): string {
  const sections = [
    "You are in the EXECUTION phase. A previous agent investigated the issue and produced this plan:",
    "",
    plan,
    "",
    "---",
    "## INSTRUCTIONS — EXECUTION PHASE",
    "",
    "Execute the plan above exactly. Do NOT re-investigate — the plan is authoritative.",
    "1. Create branches, edit files, commit changes as needed.",
    "2. Run tests to verify.",
    "3. If a PR workflow is available, create the PR.",
    "4. When done, post an activity/action with a summary of what you did. Do NOT use activity/response — the system will post the final response.",
    "",
    "Be concise in your tool usage — use targeted reads (grep, sed, head) not whole-file cats.",
  ];
  // When compact (subagent mode), skip the full API docs and embed only a
  // condensed reference. The subagent inherits the workspace and can use
  // exec/gh CLI directly. For non-subagent (legacy) mode, the full API docs
  // are prepended by the caller, so the compact section is omitted there.
  //
  // The per-session token and auto-detected base URL MUST be threaded in by
  // the caller — there is no LINEAR_API_TOKEN/LINEAR_API_BASE_URL env var.
  // Without a real token the subagent cannot reach the API proxy, so we omit
  // the section entirely rather than hand it a non-working placeholder.
  if (compact && creds?.apiToken) {
    sections.push(
      "",
      "## Linear API (compact)",
      "",
      "You can call the Linear API proxy to post activities and manage issues.",
      `Endpoint: POST ${creds.apiBaseUrl}`,
      `Authorization: Bearer ${creds.apiToken}`,
      "Content-Type: application/json",
      "",
      "Key actions:",
      '- { action: "activity/thought", body: "text" }',
      '- { action: "activity/action", activityAction: "verb", parameter: "subject", result: "text" }',
      '- { action: "activity/response", body: "text" } — ONLY when completely done, ends session',
      '- { action: "session/plan", plan: [{ content: "step", status: "inProgress" }] }',
      '- { action: "query/issue" }',
    );
  }
  return sections.join("\n");
}




function shouldUseMultiPhase(action: string, prompt: string): boolean {
  // Only use multi-phase for "created" actions (new issues) with substantial prompts
  // "prompted" (follow-ups) are usually shorter and don't need splitting
  return action === "created";
}

// Guard against duplicate agent runs for the same session.
// Linear sends both an AgentSessionEvent and a Comment webhook for the
// same interaction; without dedup both trigger an agent run.
// Maps session ID → timestamp when marked inflight.
const inflightSessions = new Map<string, number>();
const DEDUP_WINDOW_MS = 5_000;
const INFLIGHT_STALE_MS = 60 * 60 * 1000; // 1 hour -- anything older is definitely stale

// Periodic sweep: clear inflight entries that are older than INFLIGHT_STALE_MS.
// This prevents permanent blocks if a session's cleanup path throws before deletion.
setInterval(() => {
  const cutoff = Date.now() - INFLIGHT_STALE_MS;
  for (const [key, ts] of inflightSessions) {
    if (ts < cutoff) inflightSessions.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function postActivityFireAndForget(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trace: string,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): void {
  const prefix = tracePrefix(trace);
  postActivity(api, cfg, session, content, { ...opts, trace }).catch((err) => {
    api.logger.warn?.(
      `${prefix}linear: failed to post ${content.type} activity: ${formatError(err)}`,
    );
  });
}

async function handleIssueDelegateUnassignment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
): Promise<boolean> {
  const kind = readString(data.type) ?? "";
  const action = readString(data.action) ?? "";
  if (kind !== "Issue" || action !== "update") return false;

  const updatedFrom = readObject(data.updatedFrom);
  if (!updatedFrom || !hasDelegateChange(updatedFrom)) return false;

  const trace = resolveTraceId(data, delivery, "");
  const prefix = tracePrefix(trace);
  let viewerId = "";
  try {
    viewerId = await resolveViewer(api, cfg);
  } catch (err) {
    api.logger.warn?.(`${prefix}linear: failed to resolve viewer for delegate removal: ${formatError(err)}`);
    return false;
  }

  const unassignment = resolveDelegateUnassignment(data, viewerId);
  if (!unassignment) return false;

  const canceled = cancelActiveRunsForIssue(
    unassignment.issueId,
    "delegate-unassigned",
  );
  if (canceled.length === 0) {
    api.logger.info?.(
      `${prefix}linear issue delegate removed from app user; no active runs for issue ${unassignment.issueId.slice(0, 8)}...`,
    );
    return true;
  }

  api.logger.info?.(
    `${prefix}linear issue delegate removed from app user; canceling ${canceled.length} active run(s) for issue ${unassignment.issueId.slice(0, 8)}...`,
  );
  for (const run of canceled) {
    if (run.apiToken) revokeSessionToken(run.apiToken);
    if (run.sessionId) {
      cleanupSession(run.sessionId);
      clearResponseFlag(run.sessionId);
    }
    for (const sessionKey of run.sessionKeys) {
      deleteAgentSession(api, trace, sessionKey);
    }
    postActivityFireAndForget(api, cfg, trace, run.sessionId, {
      type: "response",
      body: "Canceled because this issue is no longer delegated to me.",
    });
  }
  return true;
}

function hasDelegateChange(data: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(data, "delegateId") ||
    Object.prototype.hasOwnProperty.call(data, "delegate")
  );
}

function deleteAgentSession(
  api: OpenClawPluginApi,
  trace: string,
  sessionKey: string,
): void {
  const deleteSession = api.subagent?.deleteSession;
  if (!deleteSession) return;
  const prefix = tracePrefix(trace);
  deleteSession.call(api.subagent, { sessionKey }).catch((err) => {
    api.logger.warn?.(
      `${prefix}linear: failed to delete agent session ${sessionKey}: ${formatError(err)}`,
    );
  });
}

export function createLinearWebhook(
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
    const secret = cfg.linearWebhookSecret;
    const sig = readHeader(req, "linear-signature");
    const delivery = readHeader(req, "linear-delivery");
    // Fail closed: an unconfigured secret must NOT mean "accept anything".
    // Without verification an attacker who can reach this URL could forge a
    // webhook and drive an autonomous agent run. Reject until a secret is set.
    if (!secret) {
      api.logger.warn?.(
        "linear webhook rejected: linearWebhookSecret is not configured — refusing to process unauthenticated webhooks. Set linearWebhookSecret to enable.",
      );
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    if (!verifySignature(secret, sig, raw)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Capture the host from incoming webhooks for base URL auto-detection
    const host = readHeader(req, "host");
    if (host) captureBaseUrl(host);

    const text = raw.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const data = normalizePayload(parsed);
    let stamp =
      typeof data.webhookTimestamp === "number"
        ? (data.webhookTimestamp as number)
        : undefined;
    if (typeof stamp === "number" && stamp > 0 && stamp < 1e12) {
      stamp = stamp * 1000;
    }
    if (stamp && Math.abs(Date.now() - stamp) > 60_000) {
      res.statusCode = 401;
      res.end("Stale webhook");
      return;
    }
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    queueMicrotask(() => {
      handleWebhook(api, cfg, data, delivery).catch((err) => {
        api.logger.warn?.(`linear webhook error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  };
}

async function handleWebhook(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
): Promise<void> {
  const kind = readString(data.type as string) ?? "";
  if (kind === "PermissionChange" || kind === "OAuthApp") {
    logEvent(api, "permission", data);
    return;
  }
  if (kind === "AppUserNotification") {
    logEvent(api, "notification", data);
    return;
  }
  if (await isSelfAuthoredComment(api, cfg, data)) {
    return;
  }
  if (await handleIssueDelegateUnassignment(api, cfg, data, delivery)) {
    return;
  }
  const sessionId = await resolveOwnedSessionId(api, cfg, data);
  if (!sessionId) {
    // Non-agent-session events reach here too — e.g. "Issue" updates we
    // subscribe to for delegate-unassignment (handled above) and any other
    // data-change events. They carry no agent session, so they are ignored.
    // Keep high-volume data-change kinds at debug to avoid log spam.
    if (kind === "Issue" || kind === "Comment") {
      api.logger.debug?.(`linear webhook ignored (${kind})`);
    } else if (kind) {
      api.logger.info?.(`linear webhook ignored (${kind})`);
    }
    return;
  }
  const eventData = resolveSessionId(data)
    ? data
    : { ...data, agentSessionId: sessionId };
  const trace = resolveTraceId(eventData, delivery, sessionId);
  const tracedEventData = { ...eventData, linearTraceId: trace };
  // Dispatch through the concurrency limiter, wrapped by the per-session
  // serializer so two events for the same session never run concurrently and
  // corrupt the session-keyed in-process state.
  const { enqueueAgentRun } = await import("./concurrency.js");
  const { runSerialized } = await import("./session-serializer.js");
  enqueueAgentRun(api, cfg, tracedEventData, delivery, (a, c, d, del) =>
    runSerialized(a, c, d, del, handleAgentEvent),
  );
}

async function handleAgentEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
): Promise<void> {
  const action = resolveAction(data);
  if (!action) {
    api.logger.info?.("linear agent event ignored");
    return;
  }
  const kind = readString(data.type as string) ?? "";
  const issue = resolveIssue(data);
  const issueId = readString(issue?.id) ?? "";
  const id = readString(issue?.identifier) ?? "";
  const title = readString(issue?.title) ?? "";
  const url = readString(issue?.url) ?? "";
  const desc = readString(issue?.description) ?? "";
  const guidance = resolveGuidance(data);
  const prompt = resolvePrompt(data);
  if (action === "prompted") {
    const skipReason = shouldSkipPromptedRun(prompt);
    if (skipReason) {
      api.logger.info?.(
        `linear prompted event ignored (${skipReason})`,
      );
      return;
    }
  }

  const context = resolveContext(data);
  const compactMessage = action === "prompted";
  const team = resolveKey(issue?.team);
  const proj = resolveKey(issue?.project);
  const staticRepo = resolveRepo(cfg, team, proj);
  const agent = cfg.devAgentId ?? "dev";
  const label = buildLabel(id, title);
  const session = resolveSessionId(data);
  const trace = resolveTraceId(data, delivery, session);
  const prefix = tracePrefix(trace);

  // Dedup: skip if an agent is already running for this session.
  // "prompted" (follow-up comment) actions are allowed through UNLESS
  // the session was just created (within DEDUP_WINDOW_MS), which means
  // this is the redundant Comment webhook that accompanies session creation.
  if (session && inflightSessions.has(session)) {
    const elapsed = Date.now() - inflightSessions.get(session)!;
    if (action !== "prompted" || elapsed < DEDUP_WINDOW_MS) {
      api.logger.info?.(`${prefix}linear handler: skipping duplicate for session ${session.slice(0, 8)}... (action=${action}, elapsed=${elapsed}ms)`);
      return;
    }
  }
  // Mark in-flight immediately (before any await) to prevent races.
  if (session) inflightSessions.set(session, Date.now());

  const key = normalizeKey(session || id || randomUUID());
  const sessionKey = `agent:${agent}:linear:${key}`;
  const idem = delivery ?? randomUUID();
  const signal = resolveSignal(data);
  const deliver = Boolean(cfg.notifyChannel && cfg.notifyTo);
  let apiToken = "";
  let registeredActiveRun = false;

  const markCurrentRunActive = (): void => {
    if (!issueId || !session) return;
    registerActiveRun({
      issueId,
      sessionId: session,
      apiToken,
      sessionKeys: [sessionKey],
    });
    registeredActiveRun = true;
  };
  const unregisterCurrentRun = (): void => {
    if (!registeredActiveRun || !issueId || !session) return;
    unregisterActiveRun(issueId, session);
    registeredActiveRun = false;
  };
  const currentRunCanceled = (): boolean =>
    Boolean(issueId && session && isActiveRunCanceled(issueId, session));

  markCurrentRunActive();

  // Resolve repo. If this prompted event is the user answering a previous
  // low-confidence repo confirmation, consume that cached choice rather than
  // resolving again (which would just re-ask the same question and loop).
  let repo = staticRepo;
  let repoResolution: { repoName?: string; confidence?: number; needsConfirmation?: boolean } | undefined;
  let repoConfirmationAnswered = false;
  if (action === "prompted" && session && hasPendingRepo(session)) {
    const pending = takePendingRepo(session)!;
    repoConfirmationAnswered = true;
    if (isAffirmativeRepoAnswer(prompt)) {
      repo = pending.dir;
      api.logger.info?.(`${prefix}linear: repo confirmation accepted → ${pending.repoName}`);
    } else {
      api.logger.info?.(`${prefix}linear: repo confirmation declined for ${pending.repoName}; proceeding without an auto-resolved repo`);
      // repo stays staticRepo (possibly empty) — the agent can ask or use defaults.
    }
  }

  // Try GitHub org-based auto-resolution if configured (and we didn't just
  // resolve via a confirmation answer); otherwise fall back to static mapping.
  if (!repoConfirmationAnswered && cfg.githubOrg && !staticRepo && session && issueId) {
    try {
      const resolved = await resolveRepoWithOrg(api, cfg, issueId, session, staticRepo, team, proj);
      repo = resolved.dir;
      repoResolution = resolved;
      if (resolved.suggested && resolved.repoName) {
        api.logger.info?.(`${prefix}linear: auto-resolved repo ${resolved.repoName} → ${repo}`);
      }
    } catch (err) {
      api.logger.warn?.(`${prefix}linear: repo resolution failed: ${formatError(err)}`);
    }
  }

  if (currentRunCanceled()) {
    api.logger.info?.(`${prefix}linear: run canceled before dispatch, session=${session ? session.slice(0, 8) + "..." : "(none)"}`);
    if (session) inflightSessions.delete(session);
    if (session) cleanupSession(session);
    if (session) clearResponseFlag(session);
    unregisterCurrentRun();
    return;
  }

  // Handle stop signal
  if (signal === "stop") {
    if (session) inflightSessions.delete(session);
    unregisterCurrentRun();
    const text = buildStopText(id, title);
    postActivityFireAndForget(api, cfg, trace, session, { type: "response", body: text });
    return;
  }

  // Post initial "thinking" activity
  const thought = buildThought(action, id, title);
  postActivityFireAndForget(api, cfg, trace, session, { type: "thought", body: thought }, { ephemeral: true });

  // Fast-path for explicit close commands — only on follow-up (prompted)
  // messages. Checked BEFORE the repo-confirmation gate so an explicit "close
  // this issue" is honoured immediately rather than being intercepted by a
  // low-confidence repo question. A brand-new issue is a work request, never a
  // close command, so we never short-circuit a "created" event into a close.
  if (action === "prompted" && isCloseIntentPrompt(prompt)) {
    if (session) inflightSessions.delete(session);
    let closeText = "Не удалось определить задачу для закрытия.";
    try {
      closeText = issueId
        ? await closeIssueFromPrompt(api, cfg, issueId, id, title)
        : closeText;
    } finally {
      unregisterCurrentRun();
    }
    postActivityFireAndForget(api, cfg, trace, session, { type: "response", body: closeText });
    return;
  }

  // Apply issue policies on create (start/delegate + external URL). This runs
  // regardless of repo confirmation: the issue is ours and should be started
  // and delegated even while we wait for the user to confirm the repository.
  if (action === "created") {
    const external = resolveExternal(cfg, session, issueId);
    if (external) {
      updateSessionExternalUrl(api, cfg, session, external.url, external.label).catch((err) => {
        api.logger.warn?.(`${prefix}linear: failed to update external URL: ${formatError(err)}`);
      });
    }
    applyIssuePolicy(api, cfg, issueId).catch((err) => {
      api.logger.warn?.(`${prefix}linear: failed to apply issue policy: ${formatError(err)}`);
    });
  }

  // Repo resolution status + low-confidence confirmation GATE.
  if (repoResolution?.repoName && session) {
    const pct = Math.round((repoResolution.confidence ?? 0) * 100);
    postActivityFireAndForget(api, cfg, trace, session, {
      type: "thought",
      body: `Resolved repo: ${repoResolution.repoName} (${pct}% confidence)`,
    });

    if (repoResolution.needsConfirmation) {
      // Confidence is too low to act on blindly. Ask, remember the choice, and
      // STOP this run — do not dispatch the agent into a possibly-wrong repo.
      // The user's answer arrives as a prompted event and is consumed at the
      // top of the next run (repoConfirmationAnswered).
      setPendingRepo(session, { dir: repo, repoName: repoResolution.repoName });
      postActivityFireAndForget(api, cfg, trace, session, {
        type: "elicitation",
        body: `I'm planning to work in ${repoResolution.repoName} (${pct}% confidence). Is this the right repository?`,
      }, {
        signal: "select",
        signalMeta: {
          options: [
            { label: `Yes, use ${repoResolution.repoName}`, value: "yes" },
            { label: "No, let me specify a different repo", value: "no" },
          ],
        },
      });
      api.logger.info?.(`${prefix}linear: awaiting repo confirmation for ${repoResolution.repoName}; not dispatching agent`);
      if (session) inflightSessions.delete(session);
      unregisterCurrentRun();
      return;
    }
  }

  // Resolve team ID for context
  const issueTeamObj = readObject(issue?.team);
  const teamId = readString(issueTeamObj?.id) ?? "";

  // Generate per-session API token for agent to call back
  const enableApi = cfg.enableAgentApi !== false;
  api.logger.info?.(`${prefix}linear handler: enableApi=${enableApi} session=${session ? session.slice(0, 8) + "..." : "(none)"} issueId=${issueId.slice(0, 8) || "(none)"}`);
  if (enableApi && session) {
    const sessionCtx = {
      sessionId: session,
      issueId,
      issueIdentifier: id,
      issueTitle: title,
      issueUrl: url,
      teamId,
      repoDir: repo,
      apiToken: "", // will be set below
    };
    apiToken = createSessionToken(sessionCtx);
    sessionCtx.apiToken = apiToken;
    markCurrentRunActive();
  }

  // Build agent message — enriched with API docs if API is enabled
  let message: string;
  if (enableApi && apiToken) {
    const { getBaseUrl } = await import("../api/base-url.js");
    const apiBaseUrl = cfg.apiBaseUrl || getBaseUrl();
    api.logger.info?.(`${prefix}linear handler: ENRICHED message, apiBaseUrl=${apiBaseUrl}, tokenLen=${apiToken.length}`);
    message = buildEnrichedMessage({
      action,
      id,
      title,
      url,
      desc,
      guidance,
      prompt,
      repo,
      session,
      context,
      compact: compactMessage,
      apiBaseUrl,
      apiToken,
      issueId,
      teamId,
      repoDir: repo,
    });
  } else {
    api.logger.info?.(`${prefix}linear handler: PLAIN message (no enrichment), enableApi=${enableApi}, apiToken=${apiToken ? "set" : "empty"}`);
    message = buildMessage({
      action,
      id,
      title,
      url,
      desc,
      guidance,
      prompt,
      repo,
      session,
      context,
      compact: compactMessage,
    });
  }

  // Run the agent and post response
  try {
    let agentText: string | undefined;
    let agentError: string | undefined;

    // ── Primary: callGateway with expectFinal ──
    //
    // Uses callGateway to dispatch the agent and wait for the result.
    // The webhook already returned 202 via queueMicrotask so we don't
    // block HTTP.
    //
    // For "created" actions, uses multi-phase dispatch:
    //   Phase 1 (PLAN): Agent investigates and produces a plan.
    //   Phase 2 (EXEC): Fresh context executes the plan.
    // Each phase gets its own sessionKey so the gateway creates
    // a fresh agent session with clean context.
    //
    const useMultiPhase = shouldUseMultiPhase(action, prompt);

    // Keepalive: post ephemeral thoughts to Linear so the session
    // isn't marked "stopped responding" during long agent runs.
    // Linear expects an activity within ~10s of session creation
    // and periodically thereafter.
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let keepaliveAlive = true;
    if (session && enableApi) {
      const KEEPALIVE_INTERVAL_MS = 8_000;
      keepaliveTimer = setInterval(() => {
        if (!keepaliveAlive || currentRunCanceled()) return;
        postActivityFireAndForget(api, cfg, trace, session, {
          type: "thought",
          body: "Working…",
        }, { ephemeral: true });
      }, KEEPALIVE_INTERVAL_MS);
      if (keepaliveTimer.unref) keepaliveTimer.unref();
    }

    try {
      const call = await loadCallGateway(api);

      if (currentRunCanceled()) {
        api.logger.info?.(`${prefix}linear: run canceled before agent dispatch, session=${session ? session.slice(0, 8) + "..." : "(none)"}`);
      } else if (useMultiPhase) {
        // ── Multi-phase dispatch ──

        // Phase 1: PLAN — investigate and produce a plan
        const planSessionKey = `${sessionKey}:plan`;
        if (issueId && session) addActiveRunSessionKey(issueId, session, planSessionKey);
        api.logger.info?.(`${prefix}linear [phase=plan]: dispatching, sessionKey=${planSessionKey}`);
        postActivityFireAndForget(api, cfg, trace, session, {
          type: "thought",
          body: "Investigating issue and planning implementation…",
        }, { ephemeral: true });

        const planResult = await call({
          method: "agent",
          params: {
            message: message + PHASE_PLAN_PROMPT_SUFFIX,
            sessionKey: planSessionKey,
            label: `${label} [plan]`,
            idempotencyKey: `${idem}-plan`,
          },
          expectFinal: true,
          timeoutMs: PHASE_TIMEOUT_MS,
        });
        const planText = buildAgentResponse(planResult);
        api.logger.info?.(`${prefix}linear [phase=plan]: completed, textLen=${planText?.length ?? 0}`);
        // Intermediate phases may have posted activity/response despite instructions
        // not to — clear the flag so the final response from the handler is posted.
        if (session) clearResponseFlag(session);

        if (currentRunCanceled()) {
          api.logger.info?.(`${prefix}linear [phase=plan]: run canceled after planning, skipping execution phase`);
        } else if (!planText || planText.length < 50) {
          agentError = "Planning phase produced no useful output";
        } else {
          // Phase 2: EXEC — execute the plan
          //
          // Prefer subagent.run() with lightContext: true over callGateway.
          // The full enriched message (API docs + plan) fed to callGateway
          // triggers a Codex "blocked_tool_call" stall in the embedded run.
          // Subagent.run() with lightContext skips heavy bootstrap context,
          // giving the agent a smaller initial context that doesn't stall.
          //
          const execSessionKey = `${sessionKey}:exec`;
          if (issueId && session) addActiveRunSessionKey(issueId, session, execSessionKey);
          postActivityFireAndForget(api, cfg, trace, session, {
            type: "thought",
            body: "Implementing the plan…",
          }, { ephemeral: true });

          // Diagnostic: log subagent availability
          const subagentAvailable = api.subagent && typeof api.subagent.run === "function";
          api.logger.info?.(`${prefix}linear [phase=exec]: subagent available=${subagentAvailable}, type=${typeof api.subagent}`);
          if (subagentAvailable) {
            // ── Subagent path: lightweight context, avoids blocked_tool_call stall ──
            api.logger.info?.(`${prefix}linear [phase=exec]: dispatching via subagent, sessionKey=${execSessionKey}`);
            const subagentApiBaseUrl = cfg.apiBaseUrl || (await import("../api/base-url.js")).getBaseUrl();
            const execMessage = buildExecPhaseMessage(
              planText,
              true,
              enableApi && apiToken
                ? { apiToken, apiBaseUrl: subagentApiBaseUrl }
                : undefined,
            );

            try {
              const { runId } = await api.subagent!.run({
                sessionKey: execSessionKey,
                message: execMessage,
                idempotencyKey: `${idem}-exec`,
                deliver: false,
                lane: "subagent",
                lightContext: true,
              });
              api.logger.info?.(`${prefix}linear [phase=exec]: subagent dispatched, runId=${runId}`);

              const waitResult = await api.subagent!.waitForRun({
                runId,
                timeoutMs: AGENT_TIMEOUT_MS,
              });

              if (currentRunCanceled()) {
                api.logger.info?.(`${prefix}linear [phase=exec]: run canceled while waiting for subagent, skipping result collection`);
              } else if (waitResult.status === "ok") {
                const sessionMessages = await api.subagent!.getSessionMessages({
                  sessionKey: execSessionKey,
                  limit: 5,
                });
                const lastAssistant = [...(sessionMessages.messages || [])]
                  .reverse()
                  .find((m: Record<string, unknown>) => m.role === "assistant");
                agentText = typeof lastAssistant?.content === "string"
                  ? lastAssistant.content
                  : typeof lastAssistant?.content === "object" && lastAssistant?.content !== null
                    ? (Array.isArray(lastAssistant.content)
                      ? (lastAssistant.content as Array<Record<string, unknown>>).filter((p) => p.type === "text").map((p) => p.text ?? "").join("")
                      : String(lastAssistant.content))
                    : undefined;
                api.logger.info?.(`${prefix}linear [phase=exec]: subagent completed, textLen=${agentText?.length ?? 0}`);
              } else if (waitResult.status === "timeout") {
                agentError = "Execution phase timed out";
                api.logger.warn?.(`${prefix}linear [phase=exec]: subagent timed out, runId=${runId}`);
              } else {
                agentError = waitResult.error || "Execution phase failed";
                api.logger.warn?.(`${prefix}linear [phase=exec]: subagent error: ${agentError}, runId=${runId}`);
              }
            } catch (subagentErr) {
              if (currentRunCanceled()) {
                api.logger.info?.(`${prefix}linear [phase=exec]: run canceled during subagent execution, skipping fallback`);
              } else {
                // Subagent unavailable or failed — fall back to callGateway
                const errMsg = formatError(subagentErr);
                api.logger.warn?.(`${prefix}linear [phase=exec]: subagent failed (${errMsg}), falling back to callGateway`);
                const execApiBaseUrl = cfg.apiBaseUrl || (await import("../api/base-url.js")).getBaseUrl();
                const fallbackMessage = enableApi && apiToken
                  ? buildEnrichedMessage({
                      action: "created",
                      id, title, url, desc, guidance,
                      prompt: "",
                      repo, session, context,
                      compact: false,
                      apiBaseUrl: execApiBaseUrl, apiToken, issueId, teamId, repoDir: repo,
                    }) + "\n\n---\n" + buildExecPhaseMessage(planText, false)
                  : buildExecPhaseMessage(planText, false);
                const execResult = await call({
                  method: "agent",
                  params: {
                    message: fallbackMessage,
                    sessionKey: execSessionKey,
                    label: `${label} [exec]`,
                    idempotencyKey: `${idem}-exec`,
                  },
                  expectFinal: true,
                  timeoutMs: AGENT_TIMEOUT_MS,
                });
                agentText = buildAgentResponse(execResult);
                api.logger.info?.(`${prefix}linear [phase=exec]: callGateway fallback completed, textLen=${agentText?.length ?? 0}`);
              }
            }
          } else {
            // ── Legacy path: callGateway with full context (may stall) ──
            api.logger.info?.(`${prefix}linear [phase=exec]: subagent unavailable, using callGateway`);
            const execApiBaseUrl = cfg.apiBaseUrl || (await import("../api/base-url.js")).getBaseUrl();
            const legacyMessage = enableApi && apiToken
              ? buildEnrichedMessage({
                  action: "created",
                  id, title, url, desc, guidance,
                  prompt: "",
                  repo, session, context,
                  compact: false,
                  apiBaseUrl: execApiBaseUrl, apiToken, issueId, teamId, repoDir: repo,
                }) + "\n\n---\n" + buildExecPhaseMessage(planText, false)
              : buildExecPhaseMessage(planText, false);
            const execResult = await call({
              method: "agent",
              params: {
                message: legacyMessage,
                sessionKey: execSessionKey,
                label: `${label} [exec]`,
                idempotencyKey: `${idem}-exec`,
              },
              expectFinal: true,
              timeoutMs: AGENT_TIMEOUT_MS,
            });
            agentText = buildAgentResponse(execResult);
            api.logger.info?.(`${prefix}linear [phase=exec]: callGateway completed, textLen=${agentText?.length ?? 0}`);
          }
          // Clear response flag — the exec agent may have posted activity/response,
          // but the handler should still post the final response after all phases complete.
          if (session) clearResponseFlag(session);
        }
      } else {
        // ── Single-phase dispatch (for prompted/follow-ups) ──
        api.logger.info?.(`${prefix}linear: dispatching via callGateway, sessionKey=${sessionKey}`);
        const agentResult = await call({
          method: "agent",
          params: {
            message,
            sessionKey,
            label,
            idempotencyKey: idem,
          },
          expectFinal: true,
          timeoutMs: AGENT_TIMEOUT_MS,
        });
        agentText = buildAgentResponse(agentResult);
        api.logger.info?.(`${prefix}linear: callGateway completed, sessionKey=${sessionKey}, textLen=${agentText?.length ?? 0}`);
      }
    } catch (dispatchErr) {
      const dispatchMsg = formatError(dispatchErr);
      api.logger.warn?.(`${prefix}linear: callGateway dispatch failed (${dispatchMsg})`);
      agentError = dispatchMsg;
    } finally {
      keepaliveAlive = false;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    }

    // ── Cleanup ──
    const canceled = currentRunCanceled();
    if (session) inflightSessions.delete(session);
    if (apiToken) revokeSessionToken(apiToken);
    if (session) cleanupSession(session);
    unregisterCurrentRun();

    if (canceled) {
      if (session) clearResponseFlag(session);
      api.logger.info?.(`${prefix}linear: agent run canceled, skipping final response and post-completion tasks`);
      return;
    }

    const hasAgentResponse = session && hasPostedResponse(session);
    api.logger.info?.(`${prefix}linear: agent run done, session=${session ? session.slice(0, 8) + "..." : "(none)"}, hasResponse=${Boolean(hasAgentResponse)}, error=${Boolean(agentError)}, textLen=${agentText?.length ?? 0}`);

    // If the agent explicitly posted a response via the API, skip auto-post.
    if (hasAgentResponse) {
      clearResponseFlag(session);
      // Auto-close issue if agent ran on a "created" action and completed without error
      if (action === "created" && issueId && !agentError && resolveFlag(cfg.closeOnComplete, true)) {
        autoCloseIssue(api, cfg, issueId).catch((e) => api.logger.warn?.(`${prefix}linear: autoCloseIssue failed: ${formatError(e)}`));
      }
      return;
    }

    // ── Post agent response or error to Linear ──
    // ALWAYS post activity/response — it's the only way to end the Linear session.
    if (agentError) {
      // Dispatch itself failed — post error AND response (error alone doesn't end session)
      api.logger.info?.(`${prefix}linear: posting dispatch error to Linear, session=${session ? session.slice(0, 8) + "..." : "(none)"}`);
      await postActivity(api, cfg, session, {
        type: "error",
        body: `Agent dispatch failed: ${agentError}`,
      }, { trace }).catch((e) => api.logger.warn?.(`${prefix}linear: failed to post error to Linear: ${formatError(e)}`));
      await postActivity(api, cfg, session, {
        type: "response",
        body: "The agent could not be started (see the error above).",
      }, { trace }).catch((e) => api.logger.warn?.(`${prefix}linear: failed to post response to Linear: ${formatError(e)}`));
    } else if (agentText && agentText !== "Agent completed with no reply.") {
      api.logger.info?.(`${prefix}linear: posting agent response to Linear, session=${session ? session.slice(0, 8) + "..." : "(none)"}, textLen=${agentText.length}`);
      await postActivity(api, cfg, session, { type: "response", body: agentText }, { trace }).catch((e) => api.logger.warn?.(`${prefix}linear: failed to post response to Linear: ${formatError(e)}`));
    } else {
      // Agent completed with no text — post a minimal response so the user sees completion
      api.logger.info?.(`${prefix}linear: agent returned empty response, posting minimal response, session=${session ? session.slice(0, 8) + "..." : "(none)"}`);
      await postActivity(api, cfg, session, {
        type: "response",
        body: "Done — no further output from the agent.",
      }, { trace }).catch((e) => api.logger.warn?.(`${prefix}linear: failed to post minimal response: ${formatError(e)}`));
    }

    // ── Post-completion tasks (after response is posted) ──

    // Auto-close issue if agent ran on a "created" action and completed without error
    if (action === "created" && issueId && !agentError && resolveFlag(cfg.closeOnComplete, true)) {
      autoCloseIssue(api, cfg, issueId).catch((e) => api.logger.warn?.(`${prefix}linear: autoCloseIssue failed: ${formatError(e)}`));
    }
  } catch (err) {
    const canceled = currentRunCanceled();
    if (session) inflightSessions.delete(session);
    if (apiToken) revokeSessionToken(apiToken);
    if (session) cleanupSession(session);
    if (session) clearResponseFlag(session);
    unregisterCurrentRun();
    if (canceled) {
      api.logger.info?.(`${prefix}linear: agent run canceled after error, skipping error response`);
      return;
    }
    const msg = formatError(err);
    api.logger.warn?.(`${prefix}linear agent run failed: ${msg}`);
    // Post the error (carries the detail and renders as an error in Linear),
    // then a short terminal response to end the session. activity/error alone
    // does not end the session — only activity/response does. Await the error
    // first so it is visible before the response closes the session, and keep
    // the response concise rather than repeating the full message verbatim.
    await postActivity(api, cfg, session, {
      type: "error",
      body: `Agent run failed: ${msg}`,
    }, { trace }).catch((postErr) => {
      api.logger.warn?.(`${prefix}linear: failed to post error to Linear: ${formatError(postErr)}`);
    });
    await postActivity(api, cfg, session, {
      type: "response",
      body: "The agent run ended due to an error (see the error above).",
    }, { trace }).catch((postErr) => {
      api.logger.warn?.(`${prefix}linear: failed to post response to Linear: ${formatError(postErr)}`);
    });
  }
}

export async function postActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): Promise<void> {
  const prefix = tracePrefix(opts.trace);
  if (!session) {
    api.logger.warn?.(`${prefix}linear postActivity: no session, skipping`);
    return;
  }
  api.logger.info?.(`${prefix}linear postActivity: type=${content.type} session=${session.slice(0, 8)}... bodyLen=${typeof content.body === 'string' ? content.body.length : 0}`);
  const input: Record<string, unknown> = {
    agentSessionId: session,
    content,
  };
  if (opts.signal) input.signal = opts.signal;
  if (opts.signalMeta) input.signalMetadata = opts.signalMeta;
  if (opts.ephemeral) input.ephemeral = true;
  const result = await callLinear(api, cfg, "agentActivityCreate", {
    query: ACTIVITY_MUTATION,
    variables: { input },
  });
  if (!result.ok) {
    api.logger.warn?.(`${prefix}linear postActivity: callLinear failed for type=${content.type}`);
    return;
  }
  const root = readObject(result.data!.agentActivityCreate);
  if (root && root.success === true) {
    api.logger.info?.(`${prefix}linear postActivity: success type=${content.type}`);
    return;
  }
  api.logger.warn?.(`${prefix}linear postActivity: unexpected result: ${JSON.stringify(root).slice(0, 200)}`);
}

async function updateSessionExternalUrl(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  url: string,
  label: string,
): Promise<void> {
  if (!session || !url) return;
  const input = { addedExternalUrls: [{ label, url }] };
  const result = await callLinear(api, cfg, "agentSessionUpdate", {
    query: SESSION_UPDATE_MUTATION,
    variables: { id: session, input },
  });
  if (!result.ok) return;
  const root = readObject(result.data!.agentSessionUpdate);
  if (root && root.success === true) return;
  api.logger.warn?.("linear agentSessionUpdate failed");
}

function normalizePayload(
  input: unknown,
): Record<string, unknown> {
  const root = readObject(input);
  if (!root) return {};
  const nested = readObject(root.data);
  if (!nested) return root;
  const out: Record<string, unknown> = { ...root, ...nested };
  const kind = readString(out.type as string) ?? "";
  if (kind === "Comment" && !readObject(out.comment)) out.comment = nested;
  if (kind === "Issue" && !readObject(out.issue)) out.issue = nested;
  return out;
}

function logEvent(
  api: OpenClawPluginApi,
  label: string,
  data: Record<string, unknown>,
): void {
  const action = readString(data.action as string) ?? "";
  const name = action ? `${label} ${action}` : label;
  api.logger.info?.(`linear ${name}`);
}

export async function dispatchToAgentRuntime(
  api: OpenClawPluginApi,
  params: {
    message: string;
    agentId: string;
    sessionKey: string;
    label: string;
  },
): Promise<unknown> {
  const core = api.runtime as Record<string, unknown>;
  const cfg = api.config as Record<string, unknown>;

  const channelRouting = core.channel as Record<string, Record<string, unknown>>;
  const resolveRoute = channelRouting.routing?.resolveAgentRoute;
  if (typeof resolveRoute !== "function") {
    throw new Error("api.runtime.channel.routing.resolveAgentRoute not available");
  }

  const route = resolveRoute({
    cfg,
    channel: "linear-agent-bridge",
    accountId: "default",
    peer: { kind: "direct", id: params.sessionKey },
  });

  const channelReply = channelRouting.reply as Record<string, unknown>;
  const finalizeCtx = channelReply.finalizeInboundContext;
  const dispatchReply = channelReply.dispatchReplyWithBufferedBlockDispatcher;

  if (typeof finalizeCtx !== "function" || typeof dispatchReply !== "function") {
    throw new Error("api.runtime.channel.reply methods not available");
  }

  const ctx = finalizeCtx({
    Body: params.message,
    BodyForAgent: params.message,
    RawBody: params.message,
    CommandBody: params.message,
    From: `linear-agent-bridge:${params.sessionKey}`,
    To: `linear-agent-bridge:${route.agentId}`,
    SessionKey: route.sessionKey ?? params.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: params.label,
    SenderId: params.sessionKey,
    Provider: "linear-agent-bridge",
    Surface: "linear-agent-bridge",
    OriginatingChannel: "linear-agent-bridge",
    OriginatingTo: `linear-agent-bridge:${params.sessionKey}`,
  });

  let capturedReply: unknown = undefined;
  const dispatchStart = Date.now();

  await dispatchReply({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (reply: unknown) => {
        const replyPreview = JSON.stringify(reply).slice(0, 300);
        api.logger.info?.(`linear: deliver callback for sessionKey=${params.sessionKey}, type=${typeof reply}, preview=${replyPreview}`);
        capturedReply = reply;
      },
      onError: (err: unknown) => {
        api.logger.warn?.(`linear agent dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      },
    },
  });

  const replyType = typeof capturedReply;
  const dispatchDurationMs = Date.now() - dispatchStart;
  if (replyType === "undefined") {
    api.logger.warn?.(`linear: captured reply type=undefined — agent produced no reply after ${dispatchDurationMs}ms. sessionKey=${params.sessionKey}`);
  } else {
    const preview = JSON.stringify(capturedReply).slice(0, 300);
    api.logger.info?.(`linear: captured reply type=${replyType} after ${dispatchDurationMs}ms preview=${preview}`);
  }
  return capturedReply ?? { ok: true };
}

async function loadCallGateway(
  api: OpenClawPluginApi,
): Promise<(opts: Record<string, unknown>) => Promise<unknown>> {
  if (callRef.value) return callRef.value;
  if (api.callGateway && typeof api.callGateway === "function") {
    callRef.value = api.callGateway as (opts: Record<string, unknown>) => Promise<unknown>;
    return callRef.value;
  }
  try {
    const argv1 =
      typeof process?.argv?.[1] === "string" ? process.argv[1] : "";
    let distDir = argv1 ? path.dirname(argv1) : "";
    // argv1 is openclaw.mjs, distDir is the openclaw package root.
    // The call-*.js files are in the dist/ subdirectory.
    if (distDir && !fs.existsSync(path.join(distDir, "call-*.js"))) {
      const distSub = path.join(distDir, "dist");
      if (fs.existsSync(distSub)) distDir = distSub;
    }
    api.logger.info?.(`linear: loadCallGateway distDir=${distDir}`);
    if (distDir && fs.existsSync(distDir)) {
      const files = fs
        .readdirSync(distDir)
        .filter(
          (name) => name.startsWith("call-") && name.endsWith(".js"),
        )
        // Prefer call-D* over call--* because call--* imports entry.js
        // which has a module-level side effect that calls runCli(), causing
        // a second gateway start and a GatewayLockError crash.
        .sort((a, b) =>
          a.startsWith("call--") === b.startsWith("call--")
            ? 0
            : a.startsWith("call--")
              ? 1
              : -1,
        );
      for (const file of files) {
        try {
          const mod = await import(
            pathToFileURL(path.join(distDir, file)).href
          );
          const fn =
            (mod?.n as ((...args: unknown[]) => unknown) | undefined) ??
            (mod?.callGateway as ((...args: unknown[]) => unknown) | undefined);
          if (typeof fn === "function") {
            const auth = api.config?.gateway?.auth ?? {};
            const token =
              typeof auth.token === "string"
                ? auth.token.trim()
                : undefined;
            const password =
              typeof auth.password === "string"
                ? auth.password.trim()
                : undefined;
            const call = (opts: Record<string, unknown>) =>
              fn({
                ...opts,
                token: (opts?.token as string | undefined) ?? token,
                password:
                  (opts?.password as string | undefined) ?? password,
              });
            callRef.value = call as (opts: Record<string, unknown>) => Promise<unknown>;
            return callRef.value;
          }
        } catch (err) {
          api.logger?.debug?.(
            `linear: callGateway import failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    api.logger?.warn?.(
      `linear: failed to locate gateway callGateway: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error(
    "callGateway not available. Ensure the plugin is running inside an OpenClaw gateway process.",
  );
}
