export interface ActiveRunInput {
  issueId: string;
  sessionId: string;
  apiToken?: string;
  sessionKeys?: string[];
}

export interface ActiveRunSnapshot {
  issueId: string;
  sessionId: string;
  apiToken?: string;
  sessionKeys: string[];
  reason?: string;
}

interface ActiveRunRecord {
  issueId: string;
  sessionId: string;
  apiToken?: string;
  sessionKeys: Set<string>;
  canceledReason?: string;
  canceledAt?: number;
  abortController?: AbortController;
}

const activeRunsByIssue = new Map<string, Map<string, ActiveRunRecord>>();

// How long a canceled record is retained before being reaped. A canceled run
// is expected to observe the flag and unregister itself well within this; the
// reap is a backstop against runs that never finish (e.g. an orphaned dispatch
// whose underlying agent cannot be aborted).
const CANCELED_RETENTION_MS = 60 * 60 * 1000;

// A canceled record is only treated as a stale leftover (safe to discard when a
// new run registers) once it is older than this. This is comfortably longer
// than the in-run gap between a run's two markCurrentRunActive() calls, so a
// fresh cancel targeting the CURRENT run is never wiped out from under it.
const CANCELED_STALE_MS = 30 * 1000;

export function registerActiveRun(input: ActiveRunInput): void {
  const issueId = input.issueId.trim();
  const sessionId = input.sessionId.trim();
  if (!issueId || !sessionId) return;

  reapCanceledRuns();

  let issueRuns = activeRunsByIssue.get(issueId);
  if (!issueRuns) {
    issueRuns = new Map();
    activeRunsByIssue.set(issueId, issueRuns);
  }

  let record = issueRuns.get(sessionId);
  // A STALE leftover canceled record from a prior run must NOT taint a fresh
  // run for the same issue+session (it would make the new run see itself as
  // canceled). Replace it with a clean record. Only discard records canceled
  // long enough ago to be leftovers — a fresh cancel belongs to the current
  // run (which calls markCurrentRunActive twice) and must be preserved.
  if (
    record?.canceledReason &&
    (record.canceledAt === undefined ||
      Date.now() - record.canceledAt > CANCELED_STALE_MS)
  ) {
    record = undefined;
  }
  if (!record) {
    record = {
      issueId,
      sessionId,
      sessionKeys: new Set(),
    };
    issueRuns.set(sessionId, record);
  }

  if (input.apiToken) record.apiToken = input.apiToken;
  for (const sessionKey of input.sessionKeys ?? []) {
    addSessionKey(record, sessionKey);
  }
}

export function addActiveRunSessionKey(
  issueId: string,
  sessionId: string,
  sessionKey: string,
): void {
  const record = activeRunsByIssue.get(issueId)?.get(sessionId);
  if (!record) return;
  addSessionKey(record, sessionKey);
}

export function cancelActiveRunsForIssue(
  issueId: string,
  reason: string,
): ActiveRunSnapshot[] {
  const issueRuns = activeRunsByIssue.get(issueId);
  if (!issueRuns) return [];

  const snapshots: ActiveRunSnapshot[] = [];
  for (const record of issueRuns.values()) {
    record.canceledReason = reason;
    record.canceledAt = Date.now();
    // Real abort: signal the in-flight runEmbeddedAgent call (cooperative
    // canceledReason flag remains as a backstop for paths that poll it).
    record.abortController?.abort(reason);
    snapshots.push(snapshot(record));
  }
  return snapshots;
}

export function setActiveRunAbortController(
  issueId: string,
  sessionId: string,
  controller: AbortController,
): void {
  const record = activeRunsByIssue.get(issueId)?.get(sessionId);
  if (!record) return;
  record.abortController = controller;
}

export function getActiveRunAbortController(
  issueId: string,
  sessionId: string,
): AbortController | undefined {
  return activeRunsByIssue.get(issueId)?.get(sessionId)?.abortController;
}

/**
 * Remove canceled records older than `maxAgeMs`. Backstop against orphaned runs
 * that never unregister; also prevents a stale canceled record from lingering.
 */
export function reapCanceledRuns(maxAgeMs: number = CANCELED_RETENTION_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [issueId, issueRuns] of activeRunsByIssue) {
    for (const [sessionId, record] of issueRuns) {
      if (record.canceledAt !== undefined && record.canceledAt < cutoff) {
        issueRuns.delete(sessionId);
        removed += 1;
      }
    }
    if (issueRuns.size === 0) activeRunsByIssue.delete(issueId);
  }
  return removed;
}

export function isActiveRunCanceled(issueId: string, sessionId: string): boolean {
  const record = activeRunsByIssue.get(issueId)?.get(sessionId);
  return Boolean(record?.canceledReason);
}

export function getActiveRun(
  issueId: string,
  sessionId: string,
): ActiveRunSnapshot | null {
  const record = activeRunsByIssue.get(issueId)?.get(sessionId);
  return record ? snapshot(record) : null;
}

export function unregisterActiveRun(issueId: string, sessionId: string): void {
  const issueRuns = activeRunsByIssue.get(issueId);
  if (!issueRuns) return;
  issueRuns.delete(sessionId);
  if (issueRuns.size === 0) activeRunsByIssue.delete(issueId);
}

export function clearActiveRunsForTesting(): void {
  activeRunsByIssue.clear();
}

function addSessionKey(record: ActiveRunRecord, sessionKey: string): void {
  const key = sessionKey.trim();
  if (key) record.sessionKeys.add(key);
}

function snapshot(record: ActiveRunRecord): ActiveRunSnapshot {
  return {
    issueId: record.issueId,
    sessionId: record.sessionId,
    apiToken: record.apiToken,
    sessionKeys: [...record.sessionKeys],
    reason: record.canceledReason,
  };
}
