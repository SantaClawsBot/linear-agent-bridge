import type { PlanStep } from "../types.js";

const plansBySession = new Map<string, PlanStep[]>();

export function getPlan(sessionId: string): PlanStep[] {
  return plansBySession.get(sessionId) ?? [];
}

export function setPlan(sessionId: string, plan: PlanStep[]): void {
  plansBySession.set(sessionId, plan);
}

export function cleanupSession(sessionId: string): void {
  plansBySession.delete(sessionId);
}
