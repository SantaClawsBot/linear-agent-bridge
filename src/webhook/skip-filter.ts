import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveViewer } from "../linear-client.js";
import { readObject, readString } from "../util.js";

export function shouldSkipPromptedRun(prompt: string): string {
  const text = (prompt ?? "").trim();
  if (!text) return "empty-prompt";
  const lower = text.toLowerCase();
  const systemEcho = [
    /^received an update on\b/,
    /^starting work on\b/,
    /^stop request received\b/,
    /^agent run failed:/,
    /^working\s+\d{1,2}:\d{2}\b/,
    /^thinking\s+\d{1,2}:\d{2}\b/,
  ].some((re) => re.test(lower));
  return systemEcho ? "system-echo" : "";
}

export async function isSelfAuthoredComment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<boolean> {
  const authorId = resolveAuthorId(data);
  if (!authorId) return false;
  const viewerId = await resolveViewer(api, cfg);
  return Boolean(viewerId && authorId === viewerId);
}

function resolveAuthorId(data: Record<string, unknown>): string {
  const user = readObject(data.user);
  const userId = readString(user?.id);
  if (userId) return userId;
  const actor = readObject(data.actor);
  const actorId = readString(actor?.id);
  if (actorId) return actorId;
  const comment = readObject(data.comment);
  const commentUser = readObject(comment?.user);
  const commentUserId = readString(commentUser?.id);
  if (commentUserId) return commentUserId;
  const commentActor = readObject(comment?.actor);
  return readString(commentActor?.id) ?? "";
}
