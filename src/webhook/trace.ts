import { readString } from "../util.js";

export function resolveTraceId(
  data: Record<string, unknown>,
  delivery: string | undefined,
  session: string,
): string {
  const precomputed = readString(data.linearTraceId);
  if (precomputed) return precomputed;
  const direct = readString(delivery);
  if (direct) return direct;
  const webhookId = readString(data.webhookId);
  if (webhookId) return webhookId;
  const sessionId = readString(session);
  return sessionId ? `session:${sessionId}` : "";
}

export function tracePrefix(trace: string | undefined): string {
  return trace ? `[trace=${trace}] ` : "";
}
