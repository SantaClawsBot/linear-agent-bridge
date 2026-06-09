// === Concurrency limiter ===
// Bounds the number of simultaneous agent runs to prevent OOM
// on memory-constrained hosts. Uses Node's single-threaded
// event loop guarantee — no mutex needed between check & increment.

import type { OpenClawPluginApi, PluginConfig } from "../types.js";

const DEFAULT_MAX_CONCURRENT = 3;
let activeCount = 0;

type RunFn = (
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
) => Promise<void>;

interface QueueEntry {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  data: Record<string, unknown>;
  delivery: string | undefined;
  run: RunFn;
}

const queue: QueueEntry[] = [];

function maxConcurrent(cfg: PluginConfig): number {
  const val = cfg.maxConcurrent;
  if (typeof val === "number" && val > 0 && Number.isFinite(val)) {
    return Math.min(Math.round(val), 20); // cap at 20 for safety
  }
  return DEFAULT_MAX_CONCURRENT;
}

export function enqueueAgentRun(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
  run: RunFn,
): void {
  const limit = maxConcurrent(cfg);
  if (activeCount < limit) {
    activeCount++;
    runAndDrain(api, cfg, data, delivery, run);
  } else {
    api.logger.info?.(
      `linear: concurrency limit reached (${activeCount}/${limit}), queuing (depth=${queue.length})`,
    );
    queue.push({ api, cfg, data, delivery, run });
  }
}

async function runAndDrain(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
  run: RunFn,
): Promise<void> {
  try {
    await run(api, cfg, data, delivery);
  } finally {
    activeCount--;
    const limit = maxConcurrent(cfg);
    if (queue.length > 0 && activeCount < limit) {
      const next = queue.shift()!;
      activeCount++;
      runAndDrain(next.api, next.cfg, next.data, next.delivery, next.run);
    }
  }
}
