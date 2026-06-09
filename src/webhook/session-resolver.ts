import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveViewer } from "../linear-client.js";
import { readObject, readString, resolveFlag } from "../util.js";

// Cached viewer (our app user) ID — resolved once, reused everywhere.
const viewerRef: { value?: string } = {};

/**
 * Resolve a session ID from the webhook payload.
 * Returns just the ID — ownership must be checked separately.
 *
 * The plugin subscribes only to "Agent session events"; both `created` and
 * `prompted` (follow-up) AgentSessionEvent webhooks embed the agent session id
 * directly, so this is a pure payload read with no API call. (Comment-thread
 * follow-ups are delivered by Linear as `prompted` events, not as separate
 * Comment webhooks — see README "Webhook Setup".)
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

async function getViewerId(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
): Promise<string> {
  if (viewerRef.value) return viewerRef.value;
  const id = await resolveViewer(api, cfg);
  if (id) viewerRef.value = id;
  return id;
}

/**
 * Resolve the agent session id for an event and confirm we own it.
 *
 * The session id is read straight from the AgentSessionEvent payload (no API
 * call). Ownership is checked from the payload's appUser:
 *  - present and not ours  -> ignore (another app's session);
 *  - present and ours       -> accept;
 *  - missing                -> ignore when `requireSessionAppUser` is true
 *                              (default, fail closed), else accept (lenient,
 *                              for older webhook versions).
 */
export async function resolveOwnedSessionId(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<string> {
  const direct = resolveSessionId(data);
  if (!direct) return "";
  const payloadAppUser = resolveSessionAppUserFromPayload(data);
  if (payloadAppUser) {
    const viewerId = await getViewerId(api, cfg);
    if (viewerId && payloadAppUser !== viewerId) {
      api.logger.info?.(
        `linear: ignoring session ${direct.slice(0, 8)}... — appUser ${payloadAppUser.slice(0, 8)}... is not us (${viewerId.slice(0, 8)}...)`,
      );
      return "";
    }
    return direct;
  }
  // No appUser in the payload. Fail closed by default so we never dispatch for
  // a session we can't confirm we own; opt out with requireSessionAppUser:false.
  if (resolveFlag(cfg.requireSessionAppUser, true)) {
    api.logger.warn?.(
      `linear: ignoring session ${direct.slice(0, 8)}... — payload has no appUser to confirm ownership (set requireSessionAppUser:false to allow these through)`,
    );
    return "";
  }
  return direct;
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
