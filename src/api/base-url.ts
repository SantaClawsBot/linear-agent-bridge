let detectedBaseUrl = "";

export function captureBaseUrl(host: string): void {
  // Always use localhost with the gateway's actual port.
  // The agent runs in the same process and needs to reach the API
  // directly, not through the exe.dev TLS proxy.
  if (detectedBaseUrl) return;
  const port = host.split(":")[1] || "8189";
  detectedBaseUrl = `http://127.0.0.1:${port}/plugins/linear/api`;
}

export function getBaseUrl(): string {
  return detectedBaseUrl;
}
