// === Per-session run serializer ===
// Guarantees AT MOST ONE handler run executes per Linear agent session at a
// time. Without this, two events for the same session (e.g. two genuine
// follow-up prompts, or a retried delivery) could run concurrently and corrupt
// the in-process state that is keyed solely by session id (active-run record,
// plan, response flag).
//
// Dedup is by webhook DELIVERY ID only — an exact duplicate delivery (a Linear
// retry, or the same event re-sent) is dropped. Every event with a distinct
// delivery id is genuine and is never dropped: if a run is already active for
// the session it is QUEUED and drained sequentially, so a real user follow-up
// sent moments after a run starts is sequenced, not lost.
//
// Sequencing reuses the caller's concurrency slot: queued events for a session
// run back-to-back within the same drain loop, so one session never occupies
// more than one global concurrency slot.

import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveSessionId } from "./session-resolver.js";

export type SerializedRunFn = (
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
) => Promise<void>;

// How long a delivery id is remembered for duplicate detection.
const DELIVERY_DEDUP_TTL_MS = 60_000;
const seenDeliveries = new Map<string, number>(); // deliveryId -> expiresAt

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
}

const bySession = new Map<string, SessionState>();

/**
 * Returns true if this delivery id was already seen (a duplicate). Undefined
 * delivery ids are never treated as duplicates (we can't identify them).
 */
function isDuplicateDelivery(delivery: string | undefined): boolean {
  if (!delivery) return false;
  const now = nowMs();
  if (seenDeliveries.size > 0) {
    for (const [id, expiresAt] of seenDeliveries) {
      if (expiresAt <= now) seenDeliveries.delete(id);
    }
  }
  if (seenDeliveries.has(delivery)) return true;
  seenDeliveries.set(delivery, now + DELIVERY_DEDUP_TTL_MS);
  return false;
}

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
  if (isDuplicateDelivery(delivery)) {
    api.logger.info?.(`linear serializer: dropping duplicate delivery ${delivery}`);
    return Promise.resolve();
  }

  const session = resolveSessionId(data);
  // Nothing to serialize on — run directly.
  if (!session) return run(api, cfg, data, delivery);

  let state = bySession.get(session);
  if (!state) {
    state = { running: false, queue: [] };
    bySession.set(session, state);
  }

  if (state.running) {
    // A run is already active for this session — queue this event to run after.
    api.logger.info?.(
      `linear serializer: queuing event for active session ${session.slice(0, 8)}... (queue depth=${state.queue.length + 1})`,
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
  seenDeliveries.clear();
}
