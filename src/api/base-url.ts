let detectedBaseUrl = "";

export function captureBaseUrl(host: string): void {
  if (detectedBaseUrl) return;
  // LAN IPs and localhost are plain HTTP; ts.net domains use Tailscale HTTPS
  const isTailscale = host.endsWith(".ts.net");
  const isLocalhost = host.startsWith("127.") || host.startsWith("localhost") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.");
  const proto = isTailscale ? "https" : "http";
  // Don't include the port in the host for Tailscale (it's proxied)
  const hostPart = isTailscale ? host.split(":")[0] : host;
  detectedBaseUrl = `${proto}://${hostPart}/plugins/linear/api`;
}

export function getBaseUrl(): string {
  return detectedBaseUrl;
}
