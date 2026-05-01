import type { OpenClawPluginApi } from "./src/types.js";
import { createLinearWebhook } from "./src/webhook/handler.js";
import { createApiRouter } from "./src/api/router.js";
import { createLinearOauthRoute } from "./src/oauth/route.js";
import { createGitHubWebhook } from "./src/webhook/github-handler.js";

// Side-effect imports: register all API endpoint handlers
import "./src/api/issue-ops.js";
import "./src/api/activity-ops.js";
import "./src/api/session-ops.js";
import "./src/api/delegation-ops.js";
import "./src/api/query-ops.js";
import "./src/api/pr-ops.js";

export default function register(api: OpenClawPluginApi): void {
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
    path: "/plugins/linear/github",
    handler: createGitHubWebhook(api),
  });

  api.registerHttpRoute({
    auth: "plugin",
    path: "/plugins/linear/oauth/exchange",
    handler: createLinearOauthRoute(api),
  });
}
