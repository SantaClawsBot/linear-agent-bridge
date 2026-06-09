import type {
  OpenClawPluginApi,
  PluginConfig,
  LinearCallResult,
} from "./types.js";
import { readObject, readString } from "./util.js";
import { getStoredAccessToken, refreshStoredToken } from "./oauth/refresh.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

const warnRef = { value: false };
const viewerRef: { value?: string } = {};
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;

const circuitRef = {
  failures: 0,
  openedUntil: 0,
};

// Labels that require OAuth token (Agent Session API).
const OAUTH_ONLY_LABELS = new Set([
  "agentActivityCreate",
  "agentSessionCreate",
  "agentSessionUpdate",
  "agentSessionPlan",
]);

export function resetLinearCircuitBreaker(): void {
  circuitRef.failures = 0;
  circuitRef.openedUntil = 0;
}

export function getLinearCircuitBreakerState(): {
  failures: number;
  openedUntil: number;
  open: boolean;
} {
  const now = Date.now();
  return {
    failures: circuitRef.failures,
    openedUntil: circuitRef.openedUntil,
    open: circuitRef.openedUntil > now,
  };
}

function requiresOAuth(label: string): boolean {
  if (OAUTH_ONLY_LABELS.has(label)) return true;
  return label.startsWith("agentActivityCreate") || label.startsWith("agentSession");
}

function isCircuitOpen(now = Date.now()): boolean {
  return circuitRef.openedUntil > now;
}

function recordLinearSuccess(): void {
  circuitRef.failures = 0;
  circuitRef.openedUntil = 0;
}

function recordLinearFailure(): void {
  circuitRef.failures += 1;
  if (circuitRef.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitRef.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

export async function callLinear(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  label: string,
  body: { query: string; variables: Record<string, unknown> },
): Promise<LinearCallResult> {
  const oauthRequired = requiresOAuth(label);

  // Resolve candidate tokens.
  const stored = await getStoredAccessToken(cfg.linearTokenStorePath);
  const oauthToken = stored?.accessToken;
  const apiKey = cfg.linearApiKey;

  // Agent Session operations require OAuth; others can use either.
  // When OAuth is required and unavailable, skip the API key to avoid
  // the "Using an unexpected authentication method (apiKey)" error.
  let token: string | undefined;
  if (oauthRequired) {
    token = oauthToken;
    if (!token) {
      api.logger.warn?.(`linear ${label} requires OAuth token but none available`);
      return { ok: false };
    }
  } else {
    token = oauthToken || apiKey;
  }
  if (!token) {
    warnMissingApiKey(api);
    return { ok: false };
  }

  if (isCircuitOpen()) {
    api.logger.warn?.(`linear ${label} skipped: circuit breaker open`);
    return { ok: false };
  }

  // Linear API keys (lin_api_*) go raw; OAuth tokens use Bearer prefix
  const authHeader = token.startsWith("lin_api_") ? token : `Bearer ${token}`;
  let res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  }).catch(() => null);

  // Try one refresh cycle if OAuth credentials are configured.
  if (res?.status === 401 && oauthToken) {
    const refreshed = await refreshStoredToken(api, {
      tokenStorePath: cfg.linearTokenStorePath,
      clientId: cfg.linearOauthClientId,
      clientSecret: cfg.linearOauthClientSecret,
    });
    if (refreshed?.accessToken) {
      token = refreshed.accessToken;
      const refreshAuth = `Bearer ${token}`;
      res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: refreshAuth,
        },
        body: JSON.stringify(body),
      }).catch(() => null);
    }
  }

  if (!res) {
    recordLinearFailure();
    api.logger.warn?.(`linear ${label} failed: fetch error`);
    return { ok: false };
  }
  if (!res.ok) {
    const detail = await res.text();
    recordLinearFailure();
    api.logger.warn?.(`linear ${label} failed (${res.status}): ${detail}`);
    return { ok: false };
  }
  const json = await res.json().catch(() => null);
  const root = readObject(json);
  if (!root) {
    recordLinearFailure();
    api.logger.warn?.(`linear ${label} invalid response`);
    return { ok: false };
  }
  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = (errors as unknown[])
      .map((item) => readString(readObject(item)?.message) ?? "error")
      .filter(Boolean)
      .join("; ");
    api.logger.warn?.(`linear ${label} failed: ${detail}`);
    return { ok: false };
  }
  const data = readObject(root.data);
  if (!data) {
    recordLinearFailure();
    api.logger.warn?.(`linear ${label} missing data`);
    return { ok: false };
  }
  recordLinearSuccess();
  return { ok: true, data };
}

export async function resolveViewer(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
): Promise<string> {
  if (viewerRef.value) return viewerRef.value;
  const { VIEWER_QUERY } = await import("./graphql/queries.js");
  const result = await callLinear(api, cfg, "viewer", {
    query: VIEWER_QUERY,
    variables: {},
  });
  if (!result.ok) return "";
  const viewer = readObject(result.data!.viewer);
  const id = readString(viewer?.id) ?? "";
  if (id) viewerRef.value = id;
  return id;
}

function warnMissingApiKey(api: OpenClawPluginApi): void {
  if (warnRef.value) return;
  warnRef.value = true;
  api.logger.warn?.(
    "linear API token missing; set linearApiKey or configure OAuth exchange + token store",
  );
}
