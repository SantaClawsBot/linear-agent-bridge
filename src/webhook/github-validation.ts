import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub webhook signature (X-Hub-Signature-256 header).
 * GitHub sends: sha256=<hex>
 */
export function verifyGitHubSignature(
  secret: string,
  signatureHeader: string,
  raw: Buffer,
): boolean {
  if (!signatureHeader || !secret) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const header = Buffer.from(signatureHeader.slice(prefix.length), "hex");
  const digest = createHmac("sha256", secret).update(raw).digest();
  if (header.length !== digest.length) return false;
  return timingSafeEqual(digest, header);
}
