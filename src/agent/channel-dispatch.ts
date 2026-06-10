import {
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

import type { OpenClawPluginApi } from "../types.js";

/**
 * Options for the experimental channel-reply-pipeline dispatch path
 * (flag-gated behind `dispatchMode === "channel"`).
 *
 * The handler supplies the four poster callbacks so this module has NO direct
 * Linear coupling — it only routes OpenClaw reply blocks to the right poster.
 */
export interface ChannelDispatchOptions {
  /** Linear agent session id (what postActivity targets). */
  session: string;
  /** The bridge per-run sessionKey (`agent:<id>:linear:<key>`). */
  sessionKey: string;
  /** Agent id (cfg.devAgentId ?? "dev"). */
  agentId: string;
  /** The enriched prompt to run. */
  message: string;
  /** Human-readable conversation label. */
  label: string;
  /** Post an ephemeral reasoning/thought block. */
  postThought(text: string): void;
  /** Post a tool/action block. */
  postAction(info: { action?: string; result?: string }): void;
  /** Post the final assistant response. */
  postResponse(text: string): void;
  /** Post an error. */
  postError(text: string): void;
  /** Abort the in-flight run (e.g. on delegate-unassignment). */
  abortSignal?: AbortSignal;
}

export interface ChannelDispatchResult {
  /** True if at least one final/normal response block was delivered. */
  responded: boolean;
  /** Set when dispatch threw; the run failed. */
  error?: string;
}

const CHANNEL_ID = "linear-agent-bridge";

/**
 * Run one agent turn through the OpenClaw channel reply pipeline
 * (resolveAgentRoute → finalizeInboundContext → buffered block dispatcher) and
 * map each delivered ReplyPayload onto a Linear agent activity via the supplied
 * poster callbacks.
 *
 * Classification:
 *   - isReasoningReplyPayload(payload)            → thought
 *   - status/compaction/fallback notices          → skipped (transient)
 *   - payload.isError                             → error
 *   - info.kind === "final" (the terminal answer) → response (sets responded)
 *   - intermediate "block"/"tool" text           → action
 *
 * Unlike a chat channel (which delivers every block as a platform message),
 * Linear's `response` activity ENDS the session — so only the dispatcher's
 * `final` block maps to a response; intermediate blocks become actions.
 */
export async function dispatchViaChannelPipeline(
  api: OpenClawPluginApi,
  opts: ChannelDispatchOptions,
): Promise<ChannelDispatchResult> {
  const routing = api.runtime?.channel?.routing;
  const reply = api.runtime?.channel?.reply;
  if (!routing?.resolveAgentRoute) {
    return {
      responded: false,
      error: "api.runtime.channel.routing.resolveAgentRoute not available",
    };
  }
  if (!reply?.finalizeInboundContext || !reply?.dispatchReplyWithBufferedBlockDispatcher) {
    return {
      responded: false,
      error: "api.runtime.channel.reply methods not available",
    };
  }

  let responded = false;

  const mapPayload = (
    payload: ReplyPayload,
    info: { kind: "tool" | "block" | "final" },
  ): void => {
    // 1) reasoning / thinking lane → thought
    if (isReasoningReplyPayload(payload)) {
      opts.postThought(payload.text ?? "");
      return;
    }
    // 2) transient status notices → drop (not an assistant answer)
    if (
      payload.isStatusNotice ||
      payload.isCompactionNotice ||
      payload.isFallbackNotice
    ) {
      return;
    }
    // 3) error → error activity
    if (payload.isError) {
      opts.postError(payload.text ?? "Agent run failed");
      return;
    }
    const text = payload.text ?? "";
    // 4) the terminal answer → response (ends the Linear session). Only the
    //    first final block becomes a response; guard against duplicates.
    if (info.kind === "final") {
      if (!responded && text.trim()) {
        opts.postResponse(text);
        responded = true;
      }
      return;
    }
    // 5) intermediate block/tool text → action
    if (text.trim()) opts.postAction({ result: text });
  };

  try {
    const route = routing.resolveAgentRoute({
      cfg: api.config,
      channel: CHANNEL_ID,
      accountId: "default",
      peer: { kind: "direct", id: opts.sessionKey },
    });

    const ctx = reply.finalizeInboundContext({
      Body: opts.message,
      BodyForAgent: opts.message,
      RawBody: opts.message,
      CommandBody: opts.message,
      From: `${CHANNEL_ID}:${opts.sessionKey}`,
      To: `${CHANNEL_ID}:${route.agentId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: opts.label,
      SenderId: opts.sessionKey,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:${opts.sessionKey}`,
      CommandAuthorized: true,
    });

    await reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: api.config,
      // Thread the abort signal so a delegate-unassign actually stops the run
      // (parity with the embedded path), not just suppresses the final post.
      replyOptions: opts.abortSignal ? { abortSignal: opts.abortSignal } : undefined,
      dispatcherOptions: {
        deliver: async (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => {
          mapPayload(payload, info);
        },
        onError: (err: unknown, info: { kind: "tool" | "block" | "final" }) => {
          api.logger.warn?.(
            `linear ${info.kind} reply failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      },
    });

    return { responded };
  } catch (err) {
    return {
      responded,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
