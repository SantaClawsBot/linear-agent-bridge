let detectedBaseUrl = "";
let portLocked = false;

export function captureBaseUrl(host: string): void {
  // Always use localhost with the gateway's actual port. The agent runs in the
  // same process and needs to reach the API directly, not through the exe.dev
  // TLS proxy. Prefer the `apiBaseUrl` config over this auto-detection.
  //
  // Once we have observed a Host header that carries an explicit port we lock
  // to it. Until then we fall back to the default port but keep looking — so a
  // first port-less webhook can't permanently pin every run to the wrong port.
  if (portLocked) return;
  const port = host.split(":")[1];
  if (port) {
    detectedBaseUrl = `http://127.0.0.1:${port}/plugins/linear/api`;
    portLocked = true;
  } else if (!detectedBaseUrl) {
    detectedBaseUrl = `http://127.0.0.1:8189/plugins/linear/api`;
  }
}

export function getBaseUrl(): string {
  return detectedBaseUrl;
}
