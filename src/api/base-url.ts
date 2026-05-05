let detectedBaseUrl = "";

export function captureBaseUrl(host: string): void {
  if (detectedBaseUrl) return;
  const hostname = host.split(":")[0];
  const isPrivate =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("0.");
  // Private IPs: plain HTTP. Public hostnames: HTTPS (goes through a proxy).
  const proto = isPrivate ? "http" : "https";
  detectedBaseUrl = `${proto}://${host}/plugins/linear/api`;
}

export function getBaseUrl(): string {
  return detectedBaseUrl;
}
