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
} from "../util.js";
import { verifySignature } from "./validation.js";
import {
  resolveSessionId,
  resolveSessionIdWithFallback,
  resolveIssue,
  rememberSessionHint,
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
  resolveKey,
  resolveRepo,
  resolveExternal,
} from "./message-builder.js";
import { buildAgentResponse } from "./response-parser.js";
import { applyIssuePolicy } from "./issue-policy.js";
import { isCloseIntentPrompt, closeIssueFromPrompt } from "./close-intent.js";
import { shouldSkipPromptedRun, isSelfAuthoredComment } from "./skip-filter.js";
import { createSessionToken, revokeSessionToken } from "../agent/session-token.js";
import { buildEnrichedMessage } from "../agent/context-builder.js";
import { cleanupSession } from "../agent/plan-manager.js";
import { hasPostedResponse, clearResponseFlag } from "../agent/response-tracker.js";
import { captureBaseUrl } from "../api/base-url.js";

const callRef: { value?: (opts: Record<string, unknown>) => Promise<unknown> } = {};

const MAX_BODY = 2 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

// Guard against duplicate agent runs for the same session.
// Linear sends both an AgentSessionEvent and a Comment webhook for the
// same interaction; without dedup both trigger an agent run.
// Maps session ID → timestamp when marked inflight.
const inflightSessions = new Map<string, number>();
const DEDUP_WINDOW_MS = 5_000;

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
    if (secret && !verifySignature(secret, sig, raw)) {
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
  if (kind === "Comment" && (await isSelfAuthoredComment(api, cfg, data))) {
    return;
  }
  const sessionId = await resolveSessionIdWithFallback(api, cfg, data);
  if (!sessionId) {
    if (kind) {
      if (kind === "Comment") {
        const topKeys = Object.keys(data).join(",");
        const nested = readObject(data.data);
        const nestedKeys = nested ? Object.keys(nested).join(",") : "";
        api.logger.info?.(
          `linear webhook ignored (${kind}) keys=[${topKeys}] dataKeys=[${nestedKeys}]`,
        );
      } else {
        api.logger.info?.(`linear webhook ignored (${kind})`);
      }
    }
    return;
  }
  const eventData = resolveSessionId(data)
    ? data
    : { ...data, agentSessionId: sessionId };
  rememberSessionHint(eventData, sessionId);
  // Dispatch through concurrency limiter instead of calling handleAgentEvent directly.
  const { enqueueAgentRun } = await import("./concurrency.js");
  enqueueAgentRun(api, cfg, eventData, delivery, handleAgentEvent);
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
  const guidance = readString(data.guidance as string) ?? "";
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

  if (cfg.strictAddressing === true) {
    const viewerId = await resolveViewer(api, cfg);
    const addressed = await isExplicitlyAddressed({
      api,
      cfg,
      kind,
      action,
      data,
      prompt,
      viewerId,
      mentionHandle: cfg.mentionHandle,
    });
    if (!addressed.ok) {
      api.logger.info?.(`linear event ignored (strictAddressing: ${addressed.reason})`);
      return;
    }
  }

  const context = resolveContext(data);
  const compactMessage = action === "prompted";
  const team = resolveKey(issue?.team);
  const proj = resolveKey(issue?.project);
  const repo = resolveRepo(cfg, team, proj);
  const agent = cfg.devAgentId ?? "dev";
  const label = buildLabel(id, title);
  const session = resolveSessionId(data);

  // Dedup: skip if an agent is already running for this session.
  // "prompted" (follow-up comment) actions are allowed through UNLESS
  // the session was just created (within DEDUP_WINDOW_MS), which means
  // this is the redundant Comment webhook that accompanies session creation.
  if (session && inflightSessions.has(session)) {
    const elapsed = Date.now() - inflightSessions.get(session)!;
    if (action !== "prompted" || elapsed < DEDUP_WINDOW_MS) {
      api.logger.info?.(`linear handler: skipping duplicate for session ${session.slice(0, 8)}... (action=${action}, elapsed=${elapsed}ms)`);
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

  // Handle stop signal
  if (signal === "stop") {
    if (session) inflightSessions.delete(session);
    const text = buildStopText(id, title);
    postActivity(api, cfg, session, { type: "response", body: text }).catch(() => {});
    return;
  }

  // Post initial "thinking" activity
  const thought = buildThought(action, id, title);
  postActivity(api, cfg, session, { type: "thought", body: thought }, { ephemeral: true }).catch(() => {});

  // Fast-path for explicit close commands
  if (isCloseIntentPrompt(prompt)) {
    if (session) inflightSessions.delete(session);
    const closeText = issueId
      ? await closeIssueFromPrompt(api, cfg, issueId, id, title)
      : "Не удалось определить задачу для закрытия.";
    postActivity(api, cfg, session, { type: "response", body: closeText }).catch(() => {});
    return;
  }

  // Apply issue policies on create
  if (action === "created") {
    const external = resolveExternal(cfg, session, issueId);
    if (external) {
      updateSessionExternalUrl(api, cfg, session, external.url, external.label).catch(() => {});
    }
    applyIssuePolicy(api, cfg, issueId).catch(() => {});
  }

  // Resolve team ID for context
  const issueTeamObj = readObject(issue?.team);
  const teamId = readString(issueTeamObj?.id) ?? "";

  // Generate per-session API token for agent to call back
  const enableApi = cfg.enableAgentApi !== false;
  api.logger.info?.(`linear handler: enableApi=${enableApi} session=${session ? session.slice(0, 8) + "..." : "(none)"} issueId=${issueId.slice(0, 8) || "(none)"}`);
  let apiToken = "";
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
  }

  // Build agent message — enriched with API docs if API is enabled
  let message: string;
  if (enableApi && apiToken) {
    const { getBaseUrl } = await import("../api/base-url.js");
    const apiBaseUrl = cfg.apiBaseUrl || getBaseUrl();
    api.logger.info?.(`linear handler: ENRICHED message, apiBaseUrl=${apiBaseUrl}, tokenLen=${apiToken.length}`);
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
    api.logger.info?.(`linear handler: PLAIN message (no enrichment), enableApi=${enableApi}, apiToken=${apiToken ? "set" : "empty"}`);
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
    let agentResult: unknown;

    // Try api.runtime.channel dispatch first (native plugin API),
    // fall back to loadCallGateway (older OpenClaw versions)
    try {
      api.logger.info?.(`linear: attempting dispatchToAgentRuntime, agentId=${agent}, sessionKey=${sessionKey}`);
      agentResult = await dispatchToAgentRuntime(api, {
        message,
        agentId: agent,
        sessionKey,
        label,
      });
      api.logger.info?.(`linear: dispatchToAgentRuntime completed, result=${JSON.stringify(agentResult)}`);
    } catch (dispatchErr) {
      const dispatchMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      api.logger.info?.(`linear: runtime dispatch failed (${dispatchMsg}), trying callGateway`);
      const call = await loadCallGateway(api);
      agentResult = await call({
        method: "agent",
        params: {
          message,
          agentId: agent,
          sessionKey,
          label,
          idempotencyKey: idem,
          deliver,
          channel: cfg.notifyChannel,
          to: cfg.notifyTo,
          accountId: cfg.notifyAccountId,
        },
        expectFinal: true,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
    }

    // Agent completed successfully
    if (session) inflightSessions.delete(session);
    if (apiToken) revokeSessionToken(apiToken);
    if (session) cleanupSession(session);

    const text = buildAgentResponse(agentResult);
    if (session && hasPostedResponse(session)) {
      clearResponseFlag(session);
      return;
    }
    if (!text || text === "Agent completed with no reply.") return;
    postActivity(api, cfg, session, { type: "response", body: text }).catch(() => {});
  } catch (err) {
    if (session) inflightSessions.delete(session);
    if (apiToken) revokeSessionToken(apiToken);
    if (session) cleanupSession(session);
    if (session) clearResponseFlag(session);
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear agent run failed: ${msg}`);
    postActivity(api, cfg, session, {
      type: "error",
      body: `Agent run failed: ${msg}`,
    }).catch(() => {});
  }
}

export async function postActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): Promise<void> {
  if (!session) return;
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
  if (!result.ok) return;
  const root = readObject(result.data!.agentActivityCreate);
  if (root && root.success === true) return;
  api.logger.warn?.("linear activity failed");
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

async function isExplicitlyAddressed(input: {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  kind: string;
  action: string;
  data: Record<string, unknown>;
  prompt: string;
  viewerId: string;
  mentionHandle?: string;
}): Promise<{ ok: boolean; reason: string }> {
  const { api, cfg, kind, action, data, prompt, viewerId, mentionHandle } = input;

  // Session creation events are allowed only when delegated to this app user.
  if (action === "created") {
    const issue = resolveIssue(data);
    const delegate = readObject(issue?.delegate);
    const delegateId = readString(delegate?.id) ?? "";
    if (viewerId && delegateId && delegateId === viewerId) {
      return { ok: true, reason: "delegated-to-app" };
    }
    // In strict mode, also allow explicit mention on create events.
    const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
    const createdMentions = extractMentionHandles((prompt ?? "").toLowerCase());
    if (handle && createdMentions.has(handle)) {
      return { ok: true, reason: "explicit-mention-on-create" };
    }
    return { ok: false, reason: "created-without-delegation" };
  }

  const comment = readObject(data.comment);
  const bodyRaw = `${prompt}\n${readString(comment?.body) ?? ""}`;
  const body = bodyRaw.toLowerCase();
  const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  const mentionedHandles = extractMentionHandles(body);

  // If current comment mentions handles and not ours, skip (targeting someone else).
  if (mentionedHandles.size > 0 && handle && !mentionedHandles.has(handle)) {
    return { ok: false, reason: "mentioned-other-bot" };
  }

  // Explicit mention of this app always allows processing.
  if (handle && mentionedHandles.has(handle)) {
    return { ok: true, reason: "explicit-mention" };
  }

  // For thread replies, lock on root thread owner mention when present.
  const parentId = readString(comment?.parentId) ?? readString(data.parentId as string) ?? "";
  const commentId = readString(comment?.id) ?? readString(data.commentId as string) ?? "";
  if (kind === "Comment" && parentId) {
    const ownerHandle = await resolveThreadOwnerHandle(api, cfg, commentId, handle);
    if (ownerHandle) {
      if (handle && ownerHandle === handle) {
        return { ok: true, reason: "thread-owned-by-us" };
      }
      return { ok: false, reason: `thread-owned-by-${ownerHandle}` };
    }
    return { ok: false, reason: "thread-owner-unknown" };
  }

  return { ok: false, reason: "not-addressed" };
}

function extractMentionHandles(text: string): Set<string> {
  const matches = Array.from((text ?? "").matchAll(/@([a-z0-9._-]+)/gi));
  return new Set(matches.map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean));
}

function pickThreadOwnerHandle(handles: Set<string>, expectedHandle?: string): string {
  const expected = (expectedHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  if (expected && handles.has(expected)) return expected;
  return handles.values().next().value ?? "";
}

async function resolveThreadOwnerHandle(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
  expectedHandle?: string,
): Promise<string> {
  if (!commentId) return "";
  const { COMMENT_THREAD_NODE_QUERY } = await import("../graphql/queries.js");

  let currentId = commentId;
  let safety = 0;
  while (currentId && safety < 12) {
    safety += 1;
    const result = await callLinear(api, cfg, "commentThreadNode", {
      query: COMMENT_THREAD_NODE_QUERY,
      variables: { id: currentId },
    });
    if (!result.ok) return "";
    const node = readObject(result.data?.comment);
    if (!node) return "";

    const parentId = readString(node.parentId) ?? "";
    const body = readString(node.body) ?? "";

    if (!parentId) {
      const handles = extractMentionHandles(body.toLowerCase());
      return pickThreadOwnerHandle(handles, expectedHandle);
    }

    const parent = readObject(node.parent);
    const parentObjId = readString(parent?.id) ?? "";
    const parentObjParentId = readString(parent?.parentId) ?? "";
    if (parent && parentObjId && !parentObjParentId) {
      const rootBody = readString(parent.body) ?? "";
      const handles = extractMentionHandles(rootBody.toLowerCase());
      return pickThreadOwnerHandle(handles, expectedHandle);
    }

    currentId = parentObjId || parentId;
  }
  return "";
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

async function dispatchToAgentRuntime(
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

  await dispatchReply({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (reply: unknown) => {
        capturedReply = reply;
      },
      onError: (err: unknown) => {
        api.logger.warn?.(`linear agent dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      },
    },
  });

  api.logger.info?.(`linear: captured reply type=${typeof capturedReply}`);
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
    const distDir = argv1 ? path.dirname(argv1) : "";
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
