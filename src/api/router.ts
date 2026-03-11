import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginConfig, SessionContext } from "../types.js";
import { normalizeCfg } from "../config.js";
import { validateSessionToken } from "../agent/session-token.js";
import {
  handleCorsPreflight,
  applyCorsHeaders,
  readBody,
  readHeader,
  sendJson,
} from "../util.js";

export type ApiHandler = (params: {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  context: SessionContext;
  body: Record<string, unknown>;
  res: ServerResponse;
}) => Promise<void>;

const routes = new Map<string, ApiHandler>();

export function registerApiHandler(
  path: string,
  handler: ApiHandler,
): void {
  routes.set(path, handler);
}

export function createApiRouter(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const cfg = normalizeCfg(api.pluginConfig);
    const preflight = handleCorsPreflight({
      req,
      res,
      allowedOrigins: cfg.apiCorsOrigins,
      allowCredentials: cfg.apiCorsAllowCredentials,
    });
    if (preflight.handled) return;
    if (!preflight.allowed) {
      sendJson(res, 403, { ok: false, error: "CORS origin not allowed" });
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST, OPTIONS");
      res.end("Method Not Allowed");
      return;
    }

    applyCorsHeaders({
      req,
      res,
      allowedOrigins: cfg.apiCorsOrigins,
      allowCredentials: cfg.apiCorsAllowCredentials,
    });

    const authHeader = readHeader(req, "authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const context = validateSessionToken(token);
    if (!context) {
      sendJson(res, 401, {
        ok: false,
        error: "Invalid or expired session token",
      });
      return;
    }

    const read = await readBody(req, 512 * 1024);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(read.body.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const rawAction = typeof body.action === "string" ? body.action : "";
    const action = rawAction.startsWith("/") ? rawAction : `/${rawAction}`;
    const handler = routes.get(action);

    if (!handler) {
      sendJson(res, 404, {
        ok: false,
        error: `Unknown action: ${action || "(empty)"}`,
      });
      return;
    }

    try {
      await handler({ api, cfg, context, body, res });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.error?.(`linear api error (${action}): ${msg}`);
      sendJson(res, 500, { ok: false, error: msg });
    }
  };
}
