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
}

const activeRunsByIssue = new Map<string, Map<string, ActiveRunRecord>>();

export function registerActiveRun(input: ActiveRunInput): void {
  const issueId = input.issueId.trim();
  const sessionId = input.sessionId.trim();
  if (!issueId || !sessionId) return;

  let issueRuns = activeRunsByIssue.get(issueId);
  if (!issueRuns) {
    issueRuns = new Map();
    activeRunsByIssue.set(issueId, issueRuns);
  }

  let record = issueRuns.get(sessionId);
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
    snapshots.push(snapshot(record));
  }
  return snapshots;
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
