import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import {
  COMMENT_SESSION_QUERY,
} from "../graphql/queries.js";
import { readArray, readObject, readString, sleep } from "../util.js";

const DEFAULT_SESSION_HINT_TTL_MS = 6 * 60 * 60 * 1000;

interface TimedSessionHint {
  sessionId: string;
  expiresAt: number;
}

interface SessionHintStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface SessionHintStore {
  remember: (data: Record<string, unknown>, sessionId: string) => void;
  resolveCachedCommentSession: (data: Record<string, unknown>) => string;
  sweepExpired: () => number;
  size: () => { issues: number; comments: number };
}

export function createSessionHintStore(
  options: SessionHintStoreOptions = {},
): SessionHintStore {
  const sessionByCommentRef = new Map<string, TimedSessionHint>();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_HINT_TTL_MS;
  const now = () => (options.now ? options.now() : Date.now());
  let nextSweepAt = now() + ttlMs;

  const set = (map: Map<string, TimedSessionHint>, key: string, sessionId: string): void => {
    if (!key || !sessionId) return;
    map.set(key, { sessionId, expiresAt: now() + ttlMs });
  };

  const get = (map: Map<string, TimedSessionHint>, key: string): string => {
    if (!key) return "";
    const entry = map.get(key);
    if (!entry) return "";
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return "";
    }
    return entry.sessionId;
  };

  const sweepMap = (map: Map<string, TimedSessionHint>): number => {
    let removed = 0;
    const cutoff = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= cutoff) {
        map.delete(key);
        removed += 1;
      }
    }
    return removed;
  };

  const sweepExpired = (): number => sweepMap(sessionByCommentRef);

  const maybeSweepExpired = (): void => {
    if (now() < nextSweepAt) return;
    sweepExpired();
    nextSweepAt = now() + ttlMs;
  };

  return {
    remember(data, sessionId) {
      maybeSweepExpired();
      if (!sessionId) return;
      const comment = readObject(data.comment);
      const cid =
        readString(comment?.id) ?? readString(data.id as string) ?? "";
      set(sessionByCommentRef, cid, sessionId);

      const parentId =
        readString(comment?.parentId) ??
        readString(data.parentId as string) ??
        "";
      set(sessionByCommentRef, parentId, sessionId);
    },

    resolveCachedCommentSession(data) {
      maybeSweepExpired();
      const comment = readObject(data.comment);
      const commentId =
        readString(comment?.id) ?? readString(data.id as string) ?? "";
      const direct = get(sessionByCommentRef, commentId);
      if (direct) return direct;
      const parentId =
        readString(comment?.parentId) ??
        readString(data.parentId as string) ??
        "";
      return get(sessionByCommentRef, parentId);
    },

    sweepExpired() {
      return sweepExpired();
    },

    size() {
      sweepExpired();
      return {
        issues: 0,
        comments: sessionByCommentRef.size,
      };
    },
  };
}

const sessionHints = createSessionHintStore();

// Cached viewer (our app user) ID — resolved once, reused everywhere.
const viewerRef: { value?: string } = {};

/**
 * Resolve a session ID from the webhook payload.
 * Returns just the ID — ownership must be checked separately.
 */
export function resolveSessionId(
  data: Record<string, unknown>,
): string {
  const direct = readString(data.agentSession as string);
  if (direct) return direct;
  const directId = readString(data.agentSessionId as string);
  if (directId) return directId;
  const session = readObject(data.agentSession);
  const sessionId =
    readString(session?.id) ?? readString(session?.agentSessionId);
  if (sessionId) return sessionId;
  const activity = readObject(data.agentActivity);
  const activityId = readString(activity?.agentSessionId);
  if (activityId) return activityId;
  const activitySession = readObject(activity?.agentSession);
  const activitySessionId = readString(activitySession?.id);
  if (activitySessionId) return activitySessionId;
  const comment = readObject(data.comment);
  const commentId = readString(comment?.agentSessionId);
  if (commentId) return commentId;
  const commentSession = readObject(comment?.agentSession);
  return readString(commentSession?.id) ?? "";
}

/**
 * Try to extract the appUser ID from the webhook payload's nested session data.
 * Returns "" if not available (payload may not include it).
 */
export function resolveSessionAppUserFromPayload(
  data: Record<string, unknown>,
): string {
  const topLevel = readString(data.appUserId);
  if (topLevel) return topLevel;

  // Check data.agentSession.appUser.id
  const session = readObject(data.agentSession);
  if (session) {
    const appUserId = readString(session.appUserId);
    if (appUserId) return appUserId;
    const appUser = readObject(session.appUser);
    const id = readString(appUser?.id) ?? "";
    if (id) return id;
  }
  // Check data.agentActivity.agentSession.appUser.id
  const activity = readObject(data.agentActivity);
  if (activity) {
    const actSession = readObject(activity.agentSession);
    if (actSession) {
      const appUser = readObject(actSession.appUser);
      const id = readString(appUser?.id) ?? "";
      if (id) return id;
    }
  }
  // Check data.comment.agentSession.appUser.id
  const comment = readObject(data.comment);
  if (comment) {
    const cmtSession = readObject(comment.agentSession);
    if (cmtSession) {
      const appUser = readObject(cmtSession.appUser);
      const id = readString(appUser?.id) ?? "";
      if (id) return id;
    }
  }
  return "";
}

export function rememberSessionHint(
  data: Record<string, unknown>,
  sessionId: string,
): void {
  sessionHints.remember(data, sessionId);
}

async function getViewerId(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
): Promise<string> {
  if (viewerRef.value) return viewerRef.value;
  const id = await resolveViewer(api, cfg);
  if (id) viewerRef.value = id;
  return id;
}

export async function resolveSessionIdWithFallback(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<string> {
  const direct = resolveSessionId(data);
  if (direct) {
    // Check ownership from the webhook payload (zero extra API calls).
    // If the payload doesn't include appUser info, we allow through
    // to avoid blocking legitimate events from older webhook versions.
    const payloadAppUser = resolveSessionAppUserFromPayload(data);
    if (payloadAppUser) {
      const viewerId = await getViewerId(api, cfg);
      if (viewerId && payloadAppUser !== viewerId) {
        api.logger.info?.(
          `linear: ignoring session ${direct.slice(0, 8)}... — appUser ${payloadAppUser.slice(0, 8)}... is not us (${viewerId.slice(0, 8)}...)`,
        );
        return "";
      }
    }
    rememberSessionHint(data, direct);
    return direct;
  }
  const kind = readString(data.type as string) ?? "";
  if (kind !== "Comment") return "";

  // Resolve our viewer ID once for all fallback paths.
  const viewerId = await getViewerId(api, cfg);

  const comment = readObject(data.comment);
  const cachedSession = sessionHints.resolveCachedCommentSession(data);
  if (cachedSession) return cachedSession;
  const commentId = readString(comment?.id) ?? readString(data.id as string) ?? "";
  const parentId = readString(comment?.parentId) ?? readString(data.parentId as string) ?? "";
  const viaParent = await resolveSessionFromCommentWithRetry(
    api,
    cfg,
    parentId,
    viewerId,
  );
  if (viaParent) {
    rememberSessionHint({ ...data, id: parentId }, viaParent);
    return viaParent;
  }
  const viaComment = await resolveSessionFromCommentWithRetry(
    api,
    cfg,
    commentId,
    viewerId,
  );
  if (viaComment) {
    rememberSessionHint({ ...data, parentId }, viaComment);
    return viaComment;
  }
  return "";
}

export function resolveIssue(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const issue = readObject(data.issue);
  if (issue) return issue;
  const issueId = readString(data.issueId as string);
  if (issueId) return { id: issueId };
  const comment = readObject(data.comment);
  const commentIssue = readObject(comment?.issue);
  if (commentIssue) return commentIssue;
  const commentIssueId = readString(comment?.issueId);
  if (commentIssueId) return { id: commentIssueId };
  const session = readObject(data.agentSession);
  const sessionIssue = session ? readObject(session.issue) : undefined;
  if (sessionIssue) return sessionIssue;
  const activity = readObject(data.agentActivity);
  const activityIssue = readObject(activity?.issue);
  if (activityIssue) return activityIssue;
  const activityIssueId = readString(activity?.issueId);
  if (activityIssueId) return { id: activityIssueId };
  return undefined;
}

async function resolveSessionFromCommentWithRetry(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
  viewerId?: string,
): Promise<string> {
  if (!commentId) return "";
  const delays = [120, 350, 800];
  for (let i = 0; i < delays.length; i += 1) {
    const id = await resolveSessionFromComment(api, cfg, commentId, viewerId);
    if (id) return id;
    if (i < delays.length - 1) await sleep(delays[i]);
  }
  return "";
}

async function resolveSessionFromComment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
  viewerId?: string,
): Promise<string> {
  if (!commentId) return "";
  const result = await callLinear(api, cfg, "comment(agentSession)", {
    query: COMMENT_SESSION_QUERY,
    variables: { id: commentId },
  });
  if (!result.ok) return "";
  const comment = readObject(result.data!.comment);
  if (!comment) return "";
  return pickSessionIdFromComment(comment, viewerId);
}

/**
 * Pick the first session ID from a comment's session data.
 * If viewerId is provided, only return sessions owned by that user.
 */
export function pickSessionIdFromComment(
  comment: Record<string, unknown>,
  viewerId?: string,
): string {
  const session = readObject(comment.agentSession);
  const direct = readString(session?.id);
  if (direct) {
    if (viewerId && !isOwnedBy(session, viewerId)) return "";
    return direct;
  }
  const list = readArray(
    readObject(comment.agentSessions)?.nodes,
  );
  for (const entry of list) {
    const node = readObject(entry);
    const id = readString(node?.id);
    if (!id) continue;
    if (viewerId && !isOwnedBy(node, viewerId)) continue;
    return id;
  }
  const parent = readObject(comment.parent);
  if (!parent) return "";
  const parentSession = readObject(parent.agentSession);
  const parentDirect = readString(parentSession?.id);
  if (parentDirect) {
    if (viewerId && !isOwnedBy(parentSession, viewerId)) return "";
    return parentDirect;
  }
  const parentList = readArray(
    readObject(parent.agentSessions)?.nodes,
  );
  for (const entry of parentList) {
    const node = readObject(entry);
    const id = readString(node?.id);
    if (!id) continue;
    if (viewerId && !isOwnedBy(node, viewerId)) continue;
    return id;
  }
  return "";
}

/** Check if a session node is owned by the given viewer. */
function isOwnedBy(
  sessionNode: Record<string, unknown> | undefined,
  viewerId: string,
): boolean {
  if (!sessionNode) return false;
  const directAppUserId = readString(sessionNode.appUserId);
  if (directAppUserId) return directAppUserId === viewerId;
  const appUser = readObject(sessionNode.appUser);
  const appUserId = readString(appUser?.id) ?? "";
  // If appUser is missing from the response, allow through (graceful fallback).
  if (!appUserId) return true;
  return appUserId === viewerId;
}
