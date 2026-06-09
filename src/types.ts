// Plugin host API types come from OpenClaw itself. Import the real contract so
// the compiler catches API-shape mistakes (e.g. api.subagent vs
// api.runtime.subagent) instead of trusting a hand-written model that can drift
// from the runtime. Bridge-specific types follow below.
export type {
  OpenClawPluginApi,
  PluginRuntime,
  PluginLogger,
} from "openclaw/plugin-sdk";

export interface PluginConfig {
  devAgentId?: string;
  linearWebhookSecret?: string;
  linearApiKey?: string;
  linearOauthClientId?: string;
  linearOauthClientSecret?: string;
  linearOauthRedirectUri?: string;
  linearTokenStorePath?: string;
  notifyChannel?: string;
  notifyTo?: string;
  notifyAccountId?: string;
  repoByTeam?: Record<string, string>;
  repoByProject?: Record<string, string>;
  defaultDir?: string;
  delegateOnCreate?: boolean;
  startOnCreate?: boolean;
  externalUrlBase?: string;
  externalUrlLabel?: string;
  enableAgentApi?: boolean;
  apiBaseUrl?: string;
  apiCorsOrigins?: string[];
  apiCorsAllowCredentials?: boolean;
  /** Require the AgentSessionEvent payload to carry the session's appUser. When true (default) and the payload omits appUser info, the event is ignored rather than dispatched — fail closed. Set false to allow such events through (older webhook versions). */
  requireSessionAppUser?: boolean;
  /** When the agent finishes successfully on a "created" action, move the issue to the team's "review" workflow state for human sign-off (default: true) */
  closeOnComplete?: boolean;
  /** Maximum concurrent agent runs (default: 3) */
  maxConcurrent?: number;
  /** GitHub org name for auto-resolving repos via Linear suggestions */
  githubOrg?: string;
  /** Substring filter for repo names (applied after archiving/age filtering) */
  githubRepoFilter?: string;
  /** Max age in days for repos to include (default: 365) */
  githubRepoMaxAgeDays?: number;
}


export type ActivityType =
  | "thought"
  | "elicitation"
  | "action"
  | "response"
  | "error";

export interface ActivityContent {
  type: ActivityType;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

export interface ActivityOptions {
  signal?: string;
  signalMeta?: Record<string, unknown>;
  ephemeral?: boolean;
  trace?: string;
}

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface SessionContext {
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  teamId: string;
  repoDir: string;
  apiToken: string;
}

export interface LinearCallResult {
  ok: boolean;
  data?: Record<string, unknown>;
}

export type ReadBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; error: string };

export interface IssueInfo {
  id: string;
  teamId: string;
  stateType: string;
  delegateId: string;
}
