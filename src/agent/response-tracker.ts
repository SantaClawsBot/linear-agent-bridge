const posted = new Set<string>();

export function markResponsePosted(sessionId: string): void {
  posted.add(sessionId);
}

export function hasPostedResponse(sessionId: string): boolean {
  return posted.has(sessionId);
}

export function clearResponseFlag(sessionId: string): void {
  posted.delete(sessionId);
}
