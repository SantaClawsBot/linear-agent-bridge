import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveIssueInfo, resolveCompletedState, updateIssue } from "./issue-policy.js";

// Detects a message that is *essentially just* an imperative "close this
// issue" command. This is deliberately narrow: a match bypasses the agent
// entirely and moves the issue to a completed state, so an over-broad match
// would auto-close issues on incidental mentions ("before you close this,
// make sure the tests pass"). Callers should additionally gate this to
// follow-up (prompted) events only.
export function isCloseIntentPrompt(prompt: string): boolean {
  const text = (prompt ?? "").trim().toLowerCase();
  if (!text) return false;
  // Negative guard: never treat "don't close" as a close command.
  if (
    /не\s+закры(вай|ть|вайте|й)?/.test(text) ||
    /don'?t\s+close|do\s+not\s+close/.test(text)
  )
    return false;

  // Require a short, imperative message — not a sentence that merely contains
  // the word "close" somewhere in the middle.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return false;

  // Russian imperative close at the start of the message. (Note: JS \b is
  // ASCII-only, so use an explicit whitespace/end anchor for Cyrillic.)
  if (/^(закрой|закрыть|закройте|закрывай)(\s|$)/.test(text)) return true;
  // English: must START with "close" (optionally "please close") and refer to
  // the issue/task explicitly.
  if (
    /^(please\s+)?close\b/.test(text) &&
    /\b(it|this|that|task|issue|ticket|таск|задач[ауые]?)\b/.test(text)
  )
    return true;
  // "mark it done / complete / closed" as a short imperative.
  if (/^(please\s+)?mark\b.*\b(done|complete|completed|closed)\b/.test(text))
    return true;
  return false;
}

export async function closeIssueFromPrompt(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
  id: string,
  title: string,
): Promise<string> {
  const label = id || title || "задача";
  const info = await resolveIssueInfo(api, cfg, issueId);
  if (!info) return `Не удалось получить данные задачи ${label}.`;
  if (info.stateType === "completed")
    return `${label} уже закрыта (completed).`;
  if (info.stateType === "canceled")
    return `${label} уже в статусе canceled.`;
  if (!info.teamId)
    return `Не удалось определить workflow команды для ${label}.`;
  const stateId = await resolveCompletedState(api, cfg, info.teamId);
  if (!stateId) return `Не удалось найти статус completed для ${label}.`;
  const ok = await updateIssue(
    api,
    cfg,
    info.id,
    { stateId },
    "issueUpdate(close)",
  );
  if (!ok) return `Не удалось закрыть ${label}. Проверьте права Linear API.`;
  return `Готово: закрыл ${label}.`;
}
