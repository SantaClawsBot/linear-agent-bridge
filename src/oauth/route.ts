import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "../types.js";
import { normalizeCfg } from "../config.js";
import { readBody, readObject, readString, sendJson } from "../util.js";
import {
  type LinearTokenSet,
  resolveTokenStorePath,
  saveTokenSet,
  clearTokenCache,
} from "./token-store.js";

const MAX_BODY = 256 * 1024;

interface ExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export function createLinearOauthRoute(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const cfg = normalizeCfg(api.pluginConfig);

    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://localhost");
      const code = url.searchParams.get("code")?.trim();
      if (!code) {
        sendJson(res, 400, { ok: false, error: "Missing OAuth code query parameter" });
        return;
      }
      const tokenSet = await exchangeCode(api, code, cfg.linearOauthRedirectUri, cfg.linearOauthClientId, cfg.linearOauthClientSecret);
      if (!tokenSet) {
        sendJson(res, 400, { ok: false, error: "Failed to exchange OAuth code" });
        return;
      }
      await persistToken(cfg.linearTokenStorePath, tokenSet);
      sendJson(res, 200, {
        ok: true,
        stored: true,
        expiresAt: tokenSet.expiresAt,
        note: "Linear OAuth token stored successfully",
      });
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end("Method Not Allowed");
      return;
    }

    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = readObject(JSON.parse(read.body.toString("utf8") || "{}")) || {};
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const code = readString(payload.code);
    const redirectUri = readString(payload.redirectUri) ?? cfg.linearOauthRedirectUri;
    const clientId = readString(payload.clientId) ?? cfg.linearOauthClientId;
    const clientSecret = readString(payload.clientSecret) ?? cfg.linearOauthClientSecret;

    if (!code) {
      sendJson(res, 400, { ok: false, error: "Missing code" });
      return;
    }

    const tokenSet = await exchangeCode(api, code, redirectUri, clientId, clientSecret);
    if (!tokenSet) {
      sendJson(res, 400, { ok: false, error: "Failed to exchange OAuth code" });
      return;
    }
    await persistToken(cfg.linearTokenStorePath, tokenSet);

    sendJson(res, 200, {
      ok: true,
      stored: true,
      expiresAt: tokenSet.expiresAt,
    });
  };
}

async function persistToken(pathFromCfg: string | undefined, tokenSet: LinearTokenSet): Promise<void> {
  const storePath = resolveTokenStorePath(pathFromCfg);
  await saveTokenSet(storePath, tokenSet);
  clearTokenCache();
}

export async function exchangeCode(
  api: OpenClawPluginApi,
  code: string,
  redirectUri: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<LinearTokenSet | undefined> {
  if (!clientId || !clientSecret || !redirectUri) {
    api.logger.warn?.("linear oauth exchange skipped: missing clientId/clientSecret/redirectUri");
    return undefined;
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
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
    api.logger.warn?.(`linear oauth token exchange failed (${res?.status ?? "fetch"})`);
    return undefined;
  }

  const payload = (await res.json().catch(() => null)) as ExchangeResponse | null;
  if (!payload?.access_token) {
    api.logger.warn?.("linear oauth exchange failed: missing access_token");
    return undefined;
  }

  const now = Date.now();
  const expiresAt =
    typeof payload.expires_in === "number"
      ? new Date(now + payload.expires_in * 1000).toISOString()
      : undefined;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}
