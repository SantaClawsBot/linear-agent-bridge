import { registerApiHandler } from "./router.js";
import { postActivity } from "../webhook/handler.js";
import { readString, sendJson } from "../util.js";
import { markResponsePosted } from "../agent/response-tracker.js";

// POST /activity/thought
registerApiHandler("/activity/thought", async ({ api, cfg, context, body, res }) => {
  const text = readString(body.body as string);
  if (!text) {
    sendJson(res, 400, { ok: false, error: "body is required" });
    return;
  }
  await postActivity(
    api,
    cfg,
    context.sessionId,
    { type: "thought", body: text },
    { ephemeral: body.ephemeral === true },
  );
  sendJson(res, 200, { ok: true });
});

// POST /activity/action
registerApiHandler("/activity/action", async ({ api, cfg, context, body, res }) => {
  const activityAction = readString(body.activityAction as string);
  if (!activityAction) {
    sendJson(res, 400, { ok: false, error: "activityAction is required" });
    return;
  }
  await postActivity(api, cfg, context.sessionId, {
    type: "action",
    action: activityAction,
    parameter: readString(body.parameter as string),
    result: readString(body.result as string),
  });
  sendJson(res, 200, { ok: true });
});

// POST /activity/elicitation
registerApiHandler("/activity/elicitation", async ({ api, cfg, context, body, res }) => {
  const text = readString(body.body as string);
  if (!text) {
    sendJson(res, 400, { ok: false, error: "body is required" });
    return;
  }
  await postActivity(
    api,
    cfg,
    context.sessionId,
    { type: "elicitation", body: text },
    {
      signal: readString(body.signal as string),
      signalMeta: body.signalMeta as Record<string, unknown> | undefined,
    },
  );
  sendJson(res, 200, { ok: true });
});

// POST /activity/response
registerApiHandler("/activity/response", async ({ api, cfg, context, body, res }) => {
  const text = readString(body.body as string);
  if (!text) {
    sendJson(res, 400, { ok: false, error: "body is required" });
    return;
  }
  await postActivity(api, cfg, context.sessionId, {
    type: "response",
    body: text,
  });
  markResponsePosted(context.sessionId);
  sendJson(res, 200, { ok: true });
});

// POST /activity/error
registerApiHandler("/activity/error", async ({ api, cfg, context, body, res }) => {
  const text = readString(body.body as string);
  if (!text) {
    sendJson(res, 400, { ok: false, error: "body is required" });
    return;
  }
  await postActivity(api, cfg, context.sessionId, {
    type: "error",
    body: text,
  });
  markResponsePosted(context.sessionId);
  sendJson(res, 200, { ok: true });
});
