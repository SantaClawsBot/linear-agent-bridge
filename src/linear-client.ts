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

export async function callLinear(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  label: string,
  body: { query: string; variables: Record<string, unknown> },
): Promise<LinearCallResult> {
  let token = cfg.linearApiKey;
  if (!token) {
    const stored = await getStoredAccessToken(cfg.linearTokenStorePath);
    token = stored?.accessToken;
  }
  if (!token) {
    warnMissingApiKey(api);
    return { ok: false };
  }
  let res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).catch(() => null);

  // Try one refresh cycle if OAuth credentials are configured.
  if (res?.status === 401 && !cfg.linearApiKey) {
    const refreshed = await refreshStoredToken(api, {
      tokenStorePath: cfg.linearTokenStorePath,
      clientId: cfg.linearOauthClientId,
      clientSecret: cfg.linearOauthClientSecret,
    });
    if (refreshed?.accessToken) {
      token = refreshed.accessToken;
      res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }).catch(() => null);
    }
  }

  if (!res) {
    api.logger.warn?.(`linear ${label} failed: fetch error`);
    return { ok: false };
  }
  if (!res.ok) {
    const detail = await res.text();
    api.logger.warn?.(`linear ${label} failed (${res.status}): ${detail}`);
    return { ok: false };
  }
  const json = await res.json().catch(() => null);
  const root = readObject(json);
  if (!root) {
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
    api.logger.warn?.(`linear ${label} missing data`);
    return { ok: false };
  }
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
