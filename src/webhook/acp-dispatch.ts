/**
 * ACP-based agent dispatch.
 *
 * Spawns the agent as an external child process via the ACP runtime (acpx plugin),
 * which does NOT block the Node.js event loop.
 *
 * Uses `api.runtime.taskFlow` to create a managed TaskFlow and spawn an ACP task.
 * The ACP runtime spawns the agent as a child subprocess (Codex, Claude, etc.),
 * keeping the gateway's event loop responsive.
 *
 * Falls back to in-process dispatchReply if ACP is unavailable.
 */

import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "../types.js";

export interface AcpDispatchOptions {
  message: string;
  agentId: string;
  sessionKey: string;
  label: string;
  /** Working directory for the ACP agent */
  cwd?: string;
  /** ACP harness to use (e.g. "codex", "claude") */
  acpAgent?: string;
}

export interface AcpDispatchResult {
  ok: boolean;
  text?: string;
  error?: string;
  taskId?: string;
  flowId?: string;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_MS = 30 * 60 * 1_000; // 30 minutes

// Terminal task statuses
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

/**
 * Dispatch an agent run via ACP (out-of-process, non-blocking).
 *
 * Uses `api.runtime.taskFlow` to create a managed TaskFlow and run an ACP task.
 * The ACP runtime spawns the agent as a child subprocess (Codex, Claude, etc.),
 * keeping the gateway's event loop responsive.
 *
 * Polls task status until completion, then returns the result.
 */
export async function dispatchViaAcp(
  api: OpenClawPluginApi,
  opts: AcpDispatchOptions,
): Promise<AcpDispatchResult> {
  const runtime = api.runtime as Record<string, unknown>;
  const taskFlow = runtime.taskFlow as TaskFlowApi | undefined;

  if (!taskFlow || typeof taskFlow.bindSession !== "function") {
    return {
      ok: false,
      error: "api.runtime.taskFlow not available — ACP requires a newer OpenClaw version",
    };
  }

  // Also get the tasks.runs API for polling task status
  const tasksRuns = (runtime.tasks as Record<string, unknown>)?.runs as
    | TaskRunsApi
    | undefined;

  // Use the parent session key for flow ownership
  const parentSessionKey = opts.sessionKey;
  // Generate a proper ACP child session key: agent:<agentId>:acp:<uuid>
  const acpSessionKey = `agent:${opts.agentId}:acp:${randomUUID()}`;

  const requesterOrigin = {
    channel: "linear-agent-bridge",
    accountId: "default",
    peer: { kind: "direct", id: parentSessionKey },
  };

  // Bind to the parent session key for task flow management
  const bound = taskFlow.bindSession({
    sessionKey: parentSessionKey,
    requesterOrigin,
  });

  // Create a managed task flow for this Linear dispatch
  const flow = bound.createManaged({
    controllerId: "linear-agent-bridge/dispatch",
    goal: opts.label,
    status: "running",
  });

  api.logger.info?.(
    `linear acp: created flow ${flow.flowId}, parent=${parentSessionKey}, acpSession=${acpSessionKey}`,
  );

  // Spawn the ACP task with the correct ACP session key format
  const spawnResult = bound.runTask({
    flowId: flow.flowId,
    runtime: "acp",
    agentId: opts.agentId,
    childSessionKey: acpSessionKey,
    task: opts.message,
    label: opts.label,
    status: "running",
    startedAt: Date.now(),
  });

  if (!spawnResult.created) {
    try {
      bound.fail({ flowId: flow.flowId, expectedRevision: flow.revision });
    } catch { /* best effort */ }
    return {
      ok: false,
      error: `ACP task spawn failed: ${spawnResult.reason}`,
      flowId: flow.flowId,
    };
  }

  const task = spawnResult.task;
  const taskId = (task as Record<string, unknown>).taskId as string ??
    (task as Record<string, unknown>).id as string;
  api.logger.info?.(
    `linear acp: spawned task ${taskId} (status=${
      (task as Record<string, unknown>).status
    }, acpSession=${acpSessionKey})`,
  );

  // Poll task status until terminal
  let currentRevision = flow.revision;
  const deadline = Date.now() + MAX_POLL_MS;
  let lastLogTime = Date.now();
  let pollCount = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    // Look up task status via tasks.runs API
    let currentTask: Record<string, unknown> | undefined;
    if (tasksRuns) {
      try {
        const boundRuns = tasksRuns.bindSession({
          sessionKey: parentSessionKey,
          requesterOrigin,
        });
        currentTask = boundRuns.get(taskId) as Record<string, unknown> | undefined;
      } catch (e) {
        api.logger.info?.(`linear acp: tasks.runs.get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Fallback: check via flow
    if (!currentTask) {
      try {
        const updatedFlow = bound.get(flow.flowId) as Record<string, unknown> | undefined;
        if (updatedFlow) {
          currentRevision = (updatedFlow.revision as number) ?? currentRevision;
          const flowStatus = updatedFlow.status as string | undefined;
          // If flow reached terminal state, synthesize task result
          if (flowStatus === "succeeded" || flowStatus === "failed") {
            currentTask = {
              status: flowStatus,
              terminalSummary: updatedFlow.goal as string,
            };
          }
        }
      } catch (e) {
        api.logger.info?.(`linear acp: flow.get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const status = (currentTask?.status ?? "running") as string;

    // Periodic progress log (every ~15s)
    if (Date.now() - lastLogTime > 15_000) {
      api.logger.info?.(
        `linear acp: task ${taskId} still ${status} after ${pollCount} polls (${Math.round((Date.now() - flow.createdAt) / 1000)}s)`,
      );
      lastLogTime = Date.now();
    }

    if (TERMINAL_STATUSES.has(status)) {
      const terminalSummary = currentTask?.terminalSummary as string | undefined;
      const taskError = currentTask?.error as string | undefined;

      api.logger.info?.(
        `linear acp: task ${taskId} done — status=${status}, summaryLen=${terminalSummary?.length ?? 0}`,
      );

      // Clean up the flow
      try {
        bound.finish({ flowId: flow.flowId, expectedRevision: currentRevision });
      } catch { /* best effort */ }

      const success = status === "succeeded";
      return {
        ok: success,
        text: terminalSummary || (success ? "Agent completed." : undefined),
        error: success ? undefined : (taskError || `ACP task ${status}`),
        taskId,
        flowId: flow.flowId,
      };
    }
  }

  // Timeout
  api.logger.warn?.(`linear acp: task ${taskId} timed out after ${MAX_POLL_MS / 1000}s`);
  try {
    bound.fail({ flowId: flow.flowId, expectedRevision: currentRevision });
  } catch { /* best effort */ }

  return {
    ok: false,
    error: `ACP task timed out after ${MAX_POLL_MS / 1000}s`,
    taskId,
    flowId: flow.flowId,
  };
}

/**
 * Check if ACP dispatch is available.
 */
export function isAcpAvailable(api: OpenClawPluginApi): boolean {
  const runtime = api.runtime as Record<string, unknown>;
  const taskFlow = runtime.taskFlow as
    | { bindSession: unknown }
    | undefined;
  return !!taskFlow && typeof taskFlow.bindSession === "function";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Minimal type shims (duck-typed to avoid hard import dependencies) ──

interface TaskFlowApi {
  bindSession(params: {
    sessionKey: string;
    requesterOrigin?: Record<string, unknown>;
  }): BoundTaskFlow;
}

interface BoundTaskFlow {
  createManaged(params: Record<string, unknown>): Record<string, unknown> & { flowId: string; revision: number; createdAt: number };
  get(flowId: string): Record<string, unknown> | undefined;
  getTaskSummary?(flowId: string): Record<string, unknown> | undefined;
  runTask(params: Record<string, unknown>): { created: true; task: Record<string, unknown> } | { created: false; reason: string; found: boolean };
  finish(params: { flowId: string; expectedRevision: number }): unknown;
  fail(params: { flowId: string; expectedRevision: number }): unknown;
}

interface TaskRunsApi {
  bindSession(params: {
    sessionKey: string;
    requesterOrigin?: Record<string, unknown>;
  }): { get(taskId: string): Record<string, unknown> | undefined };
}
