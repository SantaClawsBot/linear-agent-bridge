import { readArray, readObject, readString } from "../util.js";

export function buildAgentResponse(input: unknown): string {
  const payload = readObject(input);
  if (!payload) return "";

  // Direct text reply from dispatchReply deliver callback: {text: "..."}
  const directText = readString(payload.text);
  if (directText) return directText;

  const result = readObject(payload.result);
  const payloads = readArray(result?.payloads);
  const text = collectPayloadText(payloads);
  if (text) return text;
  const status = readString(payload.status) ?? "";
  if (status === "ok") return "Agent completed with no reply.";
  return "";
}

function collectPayloadText(payloads: unknown[]): string {
  if (payloads.length === 0) return "";
  const lines: string[] = [];
  const seenMedia = new Set<string>();
  for (const entry of payloads) {
    const item = readObject(entry);
    if (!item) continue;
    const text = readString(item.text);
    if (text) lines.push(text);
    const media = collectMediaUrls(item, seenMedia);
    for (const url of media) lines.push(`Media: ${url}`);
  }
  return lines.join("\n\n");
}

function collectMediaUrls(
  item: Record<string, unknown>,
  seen: Set<string>,
): string[] {
  const urls: string[] = [];
  const direct = readString(item.mediaUrl);
  if (direct && !seen.has(direct)) {
    seen.add(direct);
    urls.push(direct);
  }
  const list = readArray(item.mediaUrls);
  for (const entry of list) {
    const url = readString(entry);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}
