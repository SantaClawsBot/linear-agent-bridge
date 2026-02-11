import { randomBytes } from "node:crypto";
import type { SessionContext } from "../types.js";

const activeTokens = new Map<string, SessionContext>();

export function createSessionToken(context: SessionContext): string {
  const token = randomBytes(32).toString("hex");
  context.apiToken = token;
  activeTokens.set(token, context);
  return token;
}

export function validateSessionToken(
  token: string,
): SessionContext | null {
  return activeTokens.get(token) ?? null;
}

export function revokeSessionToken(token: string): void {
  activeTokens.delete(token);
}
