import fs from "node:fs/promises";
import path from "node:path";

export interface LinearTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  createdAt: string;
  updatedAt: string;
}

const cacheRef = new Map<string, LinearTokenSet>();

export function resolveTokenStorePath(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const home = process.env.HOME?.trim() || "/home/ubuntu";
  return path.join(home, ".openclaw", "workspace", ".pi", "linear-oauth.json");
}

export async function loadTokenSet(filePath: string): Promise<LinearTokenSet | undefined> {
  const cached = cacheRef.get(filePath);
  if (cached) return cached;
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LinearTokenSet>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
      return undefined;
    }
    const token: LinearTokenSet = {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
    cacheRef.set(filePath, token);
    return token;
  } catch {
    return undefined;
  }
}

export async function saveTokenSet(filePath: string, token: LinearTokenSet): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(token, null, 2);
  await fs.writeFile(filePath, payload, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
  cacheRef.set(filePath, token);
}

export function clearTokenCache(filePath?: string): void {
  if (filePath) {
    cacheRef.delete(filePath);
    return;
  }
  cacheRef.clear();
}
