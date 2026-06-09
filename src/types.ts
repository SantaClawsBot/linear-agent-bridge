import type { IncomingMessage, ServerResponse } from "node:http";

export interface SubagentRunParams {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
  deliver?: boolean;
  lane?: string;
  lightContext?: boolean;
  extraSystemPrompt?: string;
  model?: string;
  provider?: string;
}

export interface SubagentRunResult {
  runId: string;
}

export interface SubagentWaitParams {
  runId: string;
  timeoutMs?: number;
}

export interface SubagentWaitResult {
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface SubagentMessagesParams {
  sessionKey: string;
  limit?: number;
}

export interface SubagentMessagesResult {
  messages: Array<Record<string, unknown>>;
}

export interface OpenClawSubagentApi {
  run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
  waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
  getSessionMessages: (params: SubagentMessagesParams) => Promise<SubagentMessagesResult>;
  getSession: (params: SubagentMessagesParams) => Promise<SubagentMessagesResult>;
  deleteSession: (params: { sessionKey: string }) => Promise<void>;
}

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  config?: { gateway?: { auth?: { token?: string; password?: string } } };
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  callGateway?: unknown;
  subagent?: OpenClawSubagentApi;
  runtime?: Record<string, unknown>;
  registerHttpRoute: (opts: {
    path: string;
    auth?: string;
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
  }) => void;
}

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
  strictAddressing?: boolean;
  mentionHandle?: string;
  apiCorsOrigins?: string[];
  apiCorsAllowCredentials?: boolean;
  /** Auto-close issue to "completed" when agent finishes successfully on a "created" action (default: true) */
  closeOnComplete?: boolean;
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
