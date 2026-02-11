import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear } from "../linear-client.js";
import {
  COMMENT_SESSION_QUERY,
  ISSUE_SESSION_QUERY,
} from "../graphql/queries.js";
import { readArray, readObject, readString, sleep } from "../util.js";

const sessionByIssueRef: Record<string, string> = {};
const sessionByCommentRef: Record<string, string> = {};

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

export async function resolveSessionIdWithFallback(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<string> {
  const direct = resolveSessionId(data);
  if (direct) {
    rememberSessionHint(data, direct);
    return direct;
  }
  const kind = readString(data.type as string) ?? "";
  if (kind !== "Comment") return "";

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
  );
  if (viaParent) {
    rememberSessionHint({ ...data, id: parentId }, viaParent);
    return viaParent;
  }
  const viaComment = await resolveSessionFromCommentWithRetry(
    api,
    cfg,
    commentId,
  );
  if (viaComment) {
    rememberSessionHint({ ...data, parentId }, viaComment);
    return viaComment;
  }
  if (!issueId) return "";
  const viaIssue = await resolveSessionFromIssue(api, cfg, issueId);
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
): Promise<string> {
  if (!commentId) return "";
  const delays = [120, 350, 800];
  for (let i = 0; i < delays.length; i += 1) {
    const id = await resolveSessionFromComment(api, cfg, commentId);
    if (id) return id;
    if (i < delays.length - 1) await sleep(delays[i]);
  }
  return "";
}

async function resolveSessionFromComment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
): Promise<string> {
  if (!commentId) return "";
  const result = await callLinear(api, cfg, "comment(agentSession)", {
    query: COMMENT_SESSION_QUERY,
    variables: { id: commentId },
  });
  if (!result.ok) return "";
  const comment = readObject(result.data!.comment);
  if (!comment) return "";
  return pickSessionIdFromComment(comment);
}

function pickSessionIdFromComment(
  comment: Record<string, unknown>,
): string {
  const session = readObject(comment.agentSession);
  const direct = readString(session?.id);
  if (direct) return direct;
  const list = readArray(
    readObject(comment.agentSessions)?.nodes,
  );
  for (const entry of list) {
    const id = readString(readObject(entry)?.id);
    if (id) return id;
  }
  const parent = readObject(comment.parent);
  if (!parent) return "";
  const parentSession = readObject(parent.agentSession);
  const parentDirect = readString(parentSession?.id);
  if (parentDirect) return parentDirect;
  const parentList = readArray(
    readObject(parent.agentSessions)?.nodes,
  );
  for (const entry of parentList) {
    const id = readString(readObject(entry)?.id);
    if (id) return id;
  }
  return "";
}

async function resolveSessionFromIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
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
    const sid = pickSessionIdFromComment(comment);
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
