import { randomBytes } from "node:crypto";
import type { SessionContext } from "../types.js";

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

interface TokenEntry {
  context: SessionContext;
  expiresAt: number;
}

interface TokenTimingOptions {
  ttlMs?: number;
  now?: () => number;
}

const activeTokens = new Map<string, TokenEntry>();

function nowFrom(options?: TokenTimingOptions): number {
  return options?.now ? options.now() : Date.now();
}

export function createSessionToken(
  context: SessionContext,
  options: TokenTimingOptions = {},
): string {
  sweepExpiredSessionTokens(nowFrom(options));
  const token = randomBytes(32).toString("hex");
  context.apiToken = token;
  activeTokens.set(token, {
    context,
    expiresAt: nowFrom(options) + (options.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
  });
  return token;
}

export function validateSessionToken(
  token: string,
  options: Pick<TokenTimingOptions, "now"> = {},
): SessionContext | null {
  const entry = activeTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= nowFrom(options)) {
    activeTokens.delete(token);
    return null;
  }
  return entry.context;
}

export function revokeSessionToken(token: string): void {
  activeTokens.delete(token);
}

export function sweepExpiredSessionTokens(now = Date.now()): number {
  let removed = 0;
  for (const [token, entry] of activeTokens) {
    if (entry.expiresAt <= now) {
      activeTokens.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function getActiveSessionTokenCount(now = Date.now()): number {
  sweepExpiredSessionTokens(now);
  return activeTokens.size;
}
