import type { OpenClawPluginApi } from "./src/types.js";
import { createLinearWebhook } from "./src/webhook/handler.js";
import { createApiRouter } from "./src/api/router.js";
import { createLinearOauthRoute } from "./src/oauth/route.js";
// Side-effect imports: register all API endpoint handlers
import "./src/api/issue-ops.js";
import "./src/api/activity-ops.js";
import "./src/api/session-ops.js";
import "./src/api/delegation-ops.js";
import "./src/api/query-ops.js";

export function register(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/linear/linear",
    handler: createLinearWebhook(api),
  });

  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/linear/api",
    handler: createApiRouter(api),
  });

  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/linear/oauth/callback",
    handler: createLinearOauthRoute(api),
  });

  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/linear/oauth/exchange",
    handler: createLinearOauthRoute(api),
  });
}

export const activate = register;

export function deactivate(api: OpenClawPluginApi): void {
  // no-op
}

const plugin = {
  id: "linear-agent-bridge",
  name: "Linear",
  description: "Linear agent webhook bridge for OpenClaw dev runs",
  register,
  activate,
  deactivate,
};

export default plugin;
