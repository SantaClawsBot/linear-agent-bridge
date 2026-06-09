// === Per-session run serializer ===
// Guarantees AT MOST ONE handler run executes per Linear agent session at a
// time. Without this, two events for the same session (e.g. the AgentSessionEvent
// and the accompanying Comment webhook for a new mention, or two genuine
// follow-up prompts) could run concurrently and corrupt the in-process state
// that is keyed solely by session id (active-run record, plan, response flag).
//
// Behaviour when a run is already active for a session:
//   - a "prompted" event arriving within DEDUP_WINDOW_MS is dropped — this is
//     the redundant Comment webhook Linear emits alongside session creation;
//   - any other event is QUEUED and run after the active run completes, so a
//     legitimate follow-up (or a `created` event racing a `prompted`) is never
//     lost, only sequenced.
//
// Sequencing reuses the caller's concurrency slot: queued events for a session
// run back-to-back within the same drain loop, so one session never occupies
// more than one global concurrency slot.

import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveSessionId } from "./session-resolver.js";
import { resolveAction } from "./message-builder.js";

export type SerializedRunFn = (
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
) => Promise<void>;

const DEDUP_WINDOW_MS = 5_000;

interface PendingEvent {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  data: Record<string, unknown>;
  delivery: string | undefined;
  run: SerializedRunFn;
}

interface SessionState {
  running: boolean;
  queue: PendingEvent[];
  lastStartedAt: number;
  activeAction: string;
}

const bySession = new Map<string, SessionState>();

/**
 * Run `run` for the event, serialized by Linear session id. Returns a promise
 * that resolves when this event's run (if it runs) completes; dropped/queued
 * events resolve immediately so the concurrency slot is freed.
 */
export function runSerialized(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
  run: SerializedRunFn,
): Promise<void> {
  const session = resolveSessionId(data);
  // Nothing to serialize on — run directly.
  if (!session) return run(api, cfg, data, delivery);

  let state = bySession.get(session);
  if (!state) {
    state = { running: false, queue: [], lastStartedAt: 0, activeAction: "" };
    bySession.set(session, state);
  }

  if (state.running) {
    const action = resolveAction(data);
    const elapsed = nowMs() - state.lastStartedAt;
    const withinWindow = elapsed < DEDUP_WINDOW_MS;
    // Drop redundant duplicates that arrive right after a run starts:
    //  - the SAME action as the active run (a retried/duplicate delivery —
    //    e.g. two "created" deliveries for the same session); and
    //  - a "prompted" while a "created" is active (the Comment webhook Linear
    //    emits alongside session creation).
    // A genuinely different event (e.g. the real "created" racing a "prompted"
    // Comment that started first, or a later follow-up) is queued, never dropped.
    if (withinWindow && (action === state.activeAction || action === "prompted")) {
      api.logger.info?.(
        `linear serializer: dropping duplicate ${action || "event"} for session ${session.slice(0, 8)}... (active=${state.activeAction || "?"}, elapsed=${elapsed}ms)`,
      );
      return Promise.resolve();
    }
    // Otherwise queue to run after the active run completes.
    api.logger.info?.(
      `linear serializer: queuing ${action || "event"} for active session ${session.slice(0, 8)}... (queue depth=${state.queue.length + 1})`,
    );
    state.queue.push({ api, cfg, data, delivery, run });
    return Promise.resolve();
  }

  return drainSession(session, state, { api, cfg, data, delivery, run });
}

async function drainSession(
  session: string,
  state: SessionState,
  first: PendingEvent,
): Promise<void> {
  state.running = true;
  let cur: PendingEvent = first;
  for (;;) {
    state.lastStartedAt = nowMs();
    state.activeAction = resolveAction(cur.data);
    try {
      await cur.run(cur.api, cur.cfg, cur.data, cur.delivery);
    } catch (err) {
      cur.api.logger.warn?.(
        `linear serializer: run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Synchronous from here until the next await: nothing can interleave, so
    // releasing the session when the queue is empty is atomic w.r.t. new events.
    const next = state.queue.shift();
    if (!next) {
      state.running = false;
      bySession.delete(session);
      return;
    }
    cur = next;
  }
}

function nowMs(): number {
  return Date.now();
}

/** Test/inspection helpers. */
export function getSerializerDepth(sessionId: string): number {
  return bySession.get(sessionId)?.queue.length ?? 0;
}

export function clearSerializerForTesting(): void {
  bySession.clear();
}
