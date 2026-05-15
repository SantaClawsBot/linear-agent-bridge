/**
 * Tracks PRs opened during a session so they can be cross-referenced.
 * This enables multi-repo PR coordination — each PR can link to its siblings.
 */

interface SessionPR {
  repoName: string;
  prUrl: string;
  prNumber?: number;
  branch: string;
  title: string;
}

const sessionPRs = new Map<string, SessionPR[]>();

export function addSessionPR(
  sessionId: string,
  pr: SessionPR,
): void {
  const list = sessionPRs.get(sessionId) ?? [];
  list.push(pr);
  sessionPRs.set(sessionId, list);
}

export function getSessionPRs(sessionId: string): SessionPR[] {
  return sessionPRs.get(sessionId) ?? [];
}

export function clearSessionPRs(sessionId: string): void {
  sessionPRs.delete(sessionId);
}
