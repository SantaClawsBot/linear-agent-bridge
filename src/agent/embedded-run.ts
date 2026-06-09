import { randomUUID } from "node:crypto";

import type { OpenClawPluginApi } from "../types.js";

export interface EmbeddedRunOptions {
  sessionId: string; // e.g. `linear:${linearAgentSessionId}`
  prompt: string; // the enriched message
  repoDir: string; // cwd for code work ("" allowed)
  agentId: string; // cfg.devAgentId ?? "dev"
  abortSignal?: AbortSignal;
  // streaming -> caller maps to Linear activities:
  onThought?: (text: string) => void;
  onAction?: (info: { action?: string; result?: string }) => void;
}

export interface EmbeddedRunResult {
  text?: string;
  aborted: boolean;
  /** Genuine run failure (the run threw). NOT set on a successful turn. */
  error?: string;
  /**
   * Non-fatal advisory for an otherwise-successful run — e.g. the agent
   * already delivered its reply via its own messaging tool (potential
   * double-send). The caller should NOT treat this as a hard failure.
   */
  note?: string;
}

/**
 * Run ONE main agent turn in-process via `api.runtime.agent.runEmbeddedAgent`
 * and return the reply inline. This is the sanctioned primitive for turning an
 * inbound webhook into a reply — it returns the assistant text directly and
 * honors `abortSignal`, replacing the `subagent.run` + `waitForRun` +
 * `getSessionMessages`-scrape pattern.
 */
export async function runEmbeddedLinearAgent(
  api: OpenClawPluginApi,
  opts: EmbeddedRunOptions,
): Promise<EmbeddedRunResult> {
  // Mirror the existing subagent-availability guard: the agent runtime only
  // exists inside an OpenClaw gateway process.
  const agentRuntime = api.runtime?.agent;
  if (!agentRuntime || typeof agentRuntime.runEmbeddedAgent !== "function") {
    throw new Error(
      "agent runtime not available — ensure the plugin is running inside an OpenClaw gateway process",
    );
  }

  const cfg = api.config; // real OpenClawConfig
  const { agentId } = opts;

  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const sessionFile = agentRuntime.session.resolveSessionFilePath(
    opts.sessionId,
    undefined,
    { agentId },
  );

  try {
    const result = await agentRuntime.runEmbeddedAgent({
      sessionId: opts.sessionId,
      runId: randomUUID(),
      sessionFile,
      workspaceDir,
      cwd: opts.repoDir || workspaceDir,
      agentDir: agentRuntime.resolveAgentDir(cfg, agentId),
      config: cfg,
      agentId,
      prompt: opts.prompt,
      timeoutMs: agentRuntime.resolveAgentTimeoutMs({ cfg }),
      abortSignal: opts.abortSignal,
      bootstrapContextMode: "full",
      // The bridge owns delivery to Linear (API proxy + handler auto-post), so
      // the agent must not also deliver via OpenClaw's message tool — that would
      // double-send / misroute. We capture its reply from the result payloads.
      disableMessageTool: true,
      onReasoningStream: (p) => opts.onThought?.(p.text ?? ""),
      onToolResult: (p) =>
        opts.onAction?.({
          result: typeof p?.text === "string" ? p.text : undefined,
        }),
    });

    const text =
      result.meta?.finalAssistantVisibleText ??
      result.payloads?.map((p) => p.text ?? "").join("");
    const trimmed = text?.trim() || undefined;

    let note: string | undefined;
    if (result.didSendViaMessagingTool) {
      // The agent already delivered via its own messaging tool. Surface the
      // text so the caller can decide, but flag the potential double-send.
      note = "agent delivered reply via its own messaging tool";
    }

    return {
      text: trimmed,
      aborted: result.meta?.aborted === true,
      note,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      aborted: opts.abortSignal?.aborted === true,
      error: message,
    };
  }
}
