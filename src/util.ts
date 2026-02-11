import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadBodyResult } from "./types.js";

export function readString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value || undefined;
}

export function readNumber(input: unknown): number | undefined {
  if (typeof input !== "number" || Number.isNaN(input)) return undefined;
  return input;
}

export function readObject(
  input: unknown,
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  return input as Record<string, unknown>;
}

export function readArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function readHeader(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

export function readBody(req: IncomingMessage, limit: number): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: ReadBodyResult): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: unknown) => {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      size += buf.length;
      if (size > limit) {
        req.destroy();
        finish({ ok: false, status: 413, error: "payload too large" });
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      finish({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", () => {
      finish({ ok: false, status: 400, error: "read error" });
    });
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function normalizeKey(input: string): string {
  const lower = input.trim().toLowerCase();
  if (!lower) return "issue";
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "issue"
  );
}

export function resolveFlag(
  value: unknown,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}
