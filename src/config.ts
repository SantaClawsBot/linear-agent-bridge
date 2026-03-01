import type { PluginConfig } from "./types.js";

export function normalizeCfg(
  input: Record<string, unknown> | undefined,
): PluginConfig {
  const cfg = input ?? {};
  return {
    devAgentId: readCfgString(cfg, "devAgentId"),
    linearWebhookSecret: readCfgString(cfg, "linearWebhookSecret"),
    linearApiKey: readCfgString(cfg, "linearApiKey"),
    linearOauthClientId: readCfgString(cfg, "linearOauthClientId"),
    linearOauthClientSecret: readCfgString(cfg, "linearOauthClientSecret"),
    linearOauthRedirectUri: readCfgString(cfg, "linearOauthRedirectUri"),
    linearTokenStorePath: readCfgString(cfg, "linearTokenStorePath"),
    notifyChannel: readCfgString(cfg, "notifyChannel"),
    notifyTo: readCfgString(cfg, "notifyTo"),
    notifyAccountId: readCfgString(cfg, "notifyAccountId"),
    repoByTeam: readCfgMap(cfg, "repoByTeam"),
    repoByProject: readCfgMap(cfg, "repoByProject"),
    defaultDir: readCfgString(cfg, "defaultDir"),
    delegateOnCreate: readCfgBool(cfg, "delegateOnCreate"),
    startOnCreate: readCfgBool(cfg, "startOnCreate"),
    externalUrlBase: readCfgString(cfg, "externalUrlBase"),
    externalUrlLabel: readCfgString(cfg, "externalUrlLabel"),
    enableAgentApi: readCfgBool(cfg, "enableAgentApi"),
    apiBaseUrl: readCfgString(cfg, "apiBaseUrl"),
  };
}

function readCfgString(
  cfg: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = cfg[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value || undefined;
}

function readCfgBool(
  cfg: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = cfg[key];
  if (typeof raw !== "boolean") return undefined;
  return raw;
}

function readCfgMap(
  cfg: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = cfg[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string" && v.trim()) {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
