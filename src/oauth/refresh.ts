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

export async function refreshStoredToken(
  api: OpenClawPluginApi,
  opts: {
    tokenStorePath?: string;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<LinearTokenSet | undefined> {
  if (!opts.clientId || !opts.clientSecret) return undefined;
  const storePath = resolveTokenStorePath(opts.tokenStorePath);
  const tokenSet = await loadTokenSet(storePath);
  const refreshToken = tokenSet?.refreshToken;
  if (!refreshToken) return undefined;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
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
