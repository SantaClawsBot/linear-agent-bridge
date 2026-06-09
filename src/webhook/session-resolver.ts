import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import {
  COMMENT_SESSION_QUERY,
  ISSUE_SESSION_QUERY,
} from "../graphql/queries.js";
import { readArray, readObject, readString, sleep } from "../util.js";

const sessionByIssueRef: Record<string, string> = {};
const sessionByCommentRef: Record<string, string> = {};

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
function resolveSessionAppUserFromPayload(
  data: Record<string, unknown>,
): string {
  // Check data.agentSession.appUser.id
  const session = readObject(data.agentSession);
  if (session) {
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
  if (!sessionId) return;
  const issue = resolveIssue(data);
  const issueId =
    readString(issue?.id) ?? readString(data.issueId as string) ?? "";
  if (issueId) sessionByIssueRef[issueId] = sessionId;
  const comment = readObject(data.comment);
  const cid =
    readString(comment?.id) ?? readString(data.id as string) ?? "";
  if (cid) sessionByCommentRef[cid] = sessionId;
  const parentId =
    readString(comment?.parentId) ??
    readString(data.parentId as string) ??
    "";
  if (parentId) sessionByCommentRef[parentId] = sessionId;
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
  const issueId =
    readString(resolveIssue(data)?.id) ??
    readString(data.issueId as string) ??
    readString(comment?.issueId as string) ??
    "";
  if (issueId && sessionByIssueRef[issueId]) {
    return sessionByIssueRef[issueId];
  }
  const commentId =
    readString(comment?.id) ?? readString(data.id as string) ?? "";
  if (commentId && sessionByCommentRef[commentId]) {
    return sessionByCommentRef[commentId];
  }
  const parentId =
    readString(comment?.parentId) ??
    readString(data.parentId as string) ??
    "";
  if (parentId && sessionByCommentRef[parentId]) {
    return sessionByCommentRef[parentId];
  }
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
  if (!issueId) return "";
  const viaIssue = await resolveSessionFromIssue(api, cfg, issueId, viewerId);
  if (viaIssue) rememberSessionHint(data, viaIssue);
  return viaIssue;
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
function pickSessionIdFromComment(
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
  const appUser = readObject(sessionNode.appUser);
  const appUserId = readString(appUser?.id) ?? "";
  // If appUser is missing from the response, allow through (graceful fallback).
  if (!appUserId) return true;
  return appUserId === viewerId;
}

async function resolveSessionFromIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
  viewerId?: string,
): Promise<string> {
  if (!issueId) return "";
  const result = await callLinear(api, cfg, "issue(session)", {
    query: ISSUE_SESSION_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return "";
  const issue = readObject(result.data!.issue);
  const comments = readObject(issue?.comments);
  const nodes = readArray(comments?.nodes);
  for (const node of nodes) {
    const comment = readObject(node);
    if (!comment) continue;
    const sid = pickSessionIdFromComment(comment, viewerId);
    if (!sid) continue;
    const cid = readString(comment.id);
    const pid = readString(comment.parentId);
    sessionByIssueRef[issueId] = sid;
    if (cid) sessionByCommentRef[cid] = sid;
    if (pid) sessionByCommentRef[pid] = sid;
    return sid;
  }
  return "";
}
