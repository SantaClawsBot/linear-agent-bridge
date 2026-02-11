import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { resolveIssueInfo, resolveCompletedState, updateIssue } from "./issue-policy.js";

export function isCloseIntentPrompt(prompt: string): boolean {
  const text = (prompt ?? "").trim().toLowerCase();
  if (!text) return false;
  if (
    /(не\s+закры(вай|ть|вайте|й)?)/.test(text) ||
    /(don't\s+close|do\s+not\s+close)/.test(text)
  )
    return false;
  if (/(закрой|закрыть|закройте|закрывай)/.test(text)) return true;
  if (
    /\bclose\b/.test(text) &&
    /\b(task|issue|ticket|таск|задач[ауые]?)\b/.test(text)
  )
    return true;
  if (/\bmark\b.*\bdone\b/.test(text)) return true;
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
