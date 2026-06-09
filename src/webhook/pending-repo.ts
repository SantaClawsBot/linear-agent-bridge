// Tracks a low-confidence repo suggestion that is awaiting user confirmation,
// keyed by Linear session. When confidence is below the high threshold the
// handler posts a select elicitation and STOPS the run instead of working in a
// possibly-wrong repo. The user's answer arrives as a separate "prompted"
// event, at which point the cached choice is consumed.

export interface PendingRepoChoice {
  dir: string;
  repoName: string;
  /** The original webhook event that asked for confirmation, so the real work
   *  request (full issue context, multi-phase) can be resumed on the answer —
   *  rather than running from the bare "yes"/"no" reply. */
  originalData: Record<string, unknown>;
}

interface PendingRepo extends PendingRepoChoice {
  expiresAt: number;
}

const pendingBySession = new Map<string, PendingRepo>();
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

export function setPendingRepo(
  sessionId: string,
  choice: PendingRepoChoice,
): void {
  if (!sessionId) return;
  pendingBySession.set(sessionId, {
    dir: choice.dir,
    repoName: choice.repoName,
    originalData: choice.originalData,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

export function hasPendingRepo(sessionId: string): boolean {
  const entry = pendingBySession.get(sessionId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    pendingBySession.delete(sessionId);
    return false;
  }
  return true;
}

/** Consume the pending choice (removes it). Returns undefined if none/expired. */
export function takePendingRepo(
  sessionId: string,
): PendingRepoChoice | undefined {
  const entry = pendingBySession.get(sessionId);
  if (!entry) return undefined;
  pendingBySession.delete(sessionId);
  if (entry.expiresAt <= Date.now()) return undefined;
  return { dir: entry.dir, repoName: entry.repoName, originalData: entry.originalData };
}

export function clearPendingRepo(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

// Interpret a free-text answer to the repo-confirmation elicitation. The select
// options are "Yes, use <repo>" / "No, let me specify a different repo", but the
// user may also type freely, so accept common affirmatives.
export function isAffirmativeRepoAnswer(prompt: string): boolean {
  const text = (prompt ?? "").trim().toLowerCase();
  if (!text) return false;
  if (/^(no\b|nope|nah|don'?t|do not|неа?|нет)\b/.test(text)) return false;
  return /^(yes|yep|yeah|yup|use\b|да|ага|подтвер)/.test(text) || /\byes,? use\b/.test(text);
}
