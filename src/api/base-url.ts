let detectedBaseUrl = "";

export function captureBaseUrl(host: string): void {
  if (detectedBaseUrl) return;
  const proto = host.endsWith(".ts.net") ? "https" : "https";
  detectedBaseUrl = `${proto}://${host}/plugins/linear/api`;
}

export function getBaseUrl(): string {
  return detectedBaseUrl;
}
