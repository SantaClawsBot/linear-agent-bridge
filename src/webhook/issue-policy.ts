import type {
  OpenClawPluginApi,
  PluginConfig,
  IssueInfo,
} from "../types.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import {
  ISSUE_INFO_QUERY,
  TEAM_STARTED_QUERY,
  TEAM_COMPLETED_QUERY,
} from "../graphql/queries.js";
import { ISSUE_UPDATE_MUTATION } from "../graphql/mutations.js";
import { readArray, readNumber, readObject, readString, resolveFlag } from "../util.js";

const stateRef: Record<string, string> = {};
const completedStateRef: Record<string, string> = {};

export async function applyIssuePolicy(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<void> {
  const start = resolveFlag(cfg.startOnCreate, true);
  const delegate = resolveFlag(cfg.delegateOnCreate, true);
  if (!issueId) return;
  if (!start && !delegate) return;
  const info = await resolveIssueInfo(api, cfg, issueId);
  if (!info) return;
  if (start) await ensureStarted(api, cfg, info);
  if (delegate) await ensureDelegate(api, cfg, info);
}

export async function resolveIssueInfo(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<IssueInfo | null> {
  if (!issueId) return null;
  const result = await callLinear(api, cfg, "issue", {
    query: ISSUE_INFO_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return null;
  const issue = readObject(result.data!.issue);
  if (!issue) return null;
  const id = readString(issue.id) ?? "";
  if (!id) return null;
  const team = readObject(issue.team);
  const state = readObject(issue.state);
  const delegateObj = readObject(issue.delegate);
  return {
    id,
    teamId: readString(team?.id) ?? "",
    stateType: readString(state?.type) ?? "",
    delegateId: readString(delegateObj?.id) ?? "",
  };
}

async function ensureStarted(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  info: IssueInfo,
): Promise<void> {
  if (!info.teamId) return;
  if (
    info.stateType === "started" ||
    info.stateType === "completed" ||
    info.stateType === "canceled"
  )
    return;
  const stateId = await resolveStartedState(api, cfg, info.teamId);
  if (!stateId) return;
  await updateIssue(api, cfg, info.id, { stateId }, "issueUpdate(state)");
}

async function ensureDelegate(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  info: IssueInfo,
): Promise<void> {
  if (info.delegateId) return;
  const viewer = await resolveViewer(api, cfg);
  if (!viewer) return;
  await updateIssue(
    api,
    cfg,
    info.id,
    { delegateId: viewer },
    "issueUpdate(delegate)",
  );
}

export async function resolveStartedState(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  teamId: string,
): Promise<string> {
  if (!teamId) return "";
  const cached = stateRef[teamId];
  if (cached) return cached;
  const result = await callLinear(api, cfg, "team(states)", {
    query: TEAM_STARTED_QUERY,
    variables: { id: teamId },
  });
  if (!result.ok) return "";
  const team = readObject(result.data!.team);
  const states = readObject(team?.states);
  const nodes = readArray(states?.nodes);
  const picked = pickLowestPosition(nodes);
  if (!picked) return "";
  stateRef[teamId] = picked;
  return picked;
}

export async function resolveCompletedState(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  teamId: string,
): Promise<string> {
  if (!teamId) return "";
  const cached = completedStateRef[teamId];
  if (cached) return cached;
  const result = await callLinear(api, cfg, "team(completed-states)", {
    query: TEAM_COMPLETED_QUERY,
    variables: { id: teamId },
  });
  if (!result.ok) return "";
  const team = readObject(result.data!.team);
  const states = readObject(team?.states);
  const nodes = readArray(states?.nodes);
  const picked = pickLowestPosition(nodes);
  if (!picked) return "";
  completedStateRef[teamId] = picked;
  return picked;
}

function pickLowestPosition(nodes: unknown[]): string {
  let best: { id: string; pos: number } | null = null;
  for (const node of nodes) {
    const item = readObject(node);
    if (!item) continue;
    const id = readString(item.id) ?? "";
    const pos = readNumber(item.position) ?? Number.POSITIVE_INFINITY;
    if (!id) continue;
    if (!best || pos < best.pos) best = { id, pos };
  }
  return best?.id ?? "";
}

export async function updateIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
  input: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  if (!issueId) return false;
  const result = await callLinear(api, cfg, label, {
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: issueId, input },
  });
  if (!result.ok) return false;
  const root = readObject(result.data!.issueUpdate);
  if (root && root.success === true) return true;
  api.logger.warn?.(`linear ${label} failed`);
  return false;
}
