import type { OpenClawPluginApi } from "../types.js";
import {
  type LinearTokenSet,
  clearTokenCache,
  loadTokenSet,
  resolveTokenStorePath,
  saveTokenSet,
} from "./token-store.js";

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export async function getStoredAccessToken(pathFromCfg?: string): Promise<LinearTokenSet | undefined> {
  const path = resolveTokenStorePath(pathFromCfg);
  return loadTokenSet(path);
}

// Single-flight: collapse concurrent refreshes for the same store path into
// one network call. Linear rotates the refresh token on each refresh, so if
// several agent runs hit a 401 at once and each POSTed independently, the first
// success would invalidate the refresh token the others are using and all but
// one would fail. Concurrent callers instead await the in-flight refresh and
// receive the same freshly-rotated token set.
const inflightRefresh = new Map<string, Promise<LinearTokenSet | undefined>>();

export function refreshStoredToken(
  api: OpenClawPluginApi,
  opts: {
    tokenStorePath?: string;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<LinearTokenSet | undefined> {
  if (!opts.clientId || !opts.clientSecret) return Promise.resolve(undefined);
  const storePath = resolveTokenStorePath(opts.tokenStorePath);
  const existing = inflightRefresh.get(storePath);
  if (existing) return existing;
  const pending = doRefreshStoredToken(api, opts, storePath).finally(() => {
    inflightRefresh.delete(storePath);
  });
  inflightRefresh.set(storePath, pending);
  return pending;
}

async function doRefreshStoredToken(
  api: OpenClawPluginApi,
  opts: {
    tokenStorePath?: string;
    clientId?: string;
    clientSecret?: string;
  },
  storePath: string,
): Promise<LinearTokenSet | undefined> {
  const { clientId, clientSecret } = opts;
  if (!clientId || !clientSecret) return undefined;
  const tokenSet = await loadTokenSet(storePath);
  const refreshToken = tokenSet?.refreshToken;
  if (!refreshToken) return undefined;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  }).catch(() => null);

  if (!res || !res.ok) {
    api.logger.warn?.(`linear oauth token refresh failed (${res?.status ?? "fetch"})`);
    return undefined;
  }

  const payload = (await res.json().catch(() => null)) as RefreshResponse | null;
  if (!payload?.access_token) {
    api.logger.warn?.("linear oauth refresh failed: missing access_token");
    return undefined;
  }

  const now = Date.now();
  const next: LinearTokenSet = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(now + payload.expires_in * 1000).toISOString()
        : tokenSet?.expiresAt,
    createdAt: tokenSet?.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  await saveTokenSet(storePath, next);
  clearTokenCache();
  return next;
}
