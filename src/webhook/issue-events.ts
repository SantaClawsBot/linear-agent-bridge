import { readObject, readString } from "../util.js";

export interface DelegateUnassignment {
  issueId: string;
  previousDelegateId: string;
  currentDelegateId: string;
}

export function resolveDelegateUnassignment(
  data: Record<string, unknown>,
  viewerId: string,
): DelegateUnassignment | null {
  const kind = readString(data.type) ?? "";
  const action = readString(data.action) ?? "";
  const appUserId = readString(viewerId) ?? "";
  if (kind !== "Issue" || action !== "update" || !appUserId) return null;

  const updatedFrom = readObject(data.updatedFrom);
  if (!updatedFrom) return null;

  const previousDelegateId = resolveDelegateId(updatedFrom);
  if (previousDelegateId !== appUserId) return null;

  const currentDelegateId = resolveDelegateId(data);
  if (currentDelegateId === appUserId) return null;

  const issueId =
    readString(data.id) ??
    readString(data.issueId) ??
    readString(readObject(data.issue)?.id) ??
    "";
  if (!issueId) return null;

  return {
    issueId,
    previousDelegateId,
    currentDelegateId,
  };
}

function resolveDelegateId(data: Record<string, unknown>): string {
  const direct = readString(data.delegateId);
  if (direct) return direct;

  const delegate = data.delegate;
  const delegateString = readString(delegate);
  if (delegateString) return delegateString;

  const delegateObj = readObject(delegate);
  return readString(delegateObj?.id) ?? "";
}
