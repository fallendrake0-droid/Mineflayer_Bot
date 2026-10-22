/**
 * Browser-origin guard for the local-first control API.
 *
 * Threat: the API listens on a TCP port, so ANY website open in the user's
 * browser can reach it (http://localhost:5000). CORS alone doesn't stop
 * state-changing "simple" requests (HTML form POSTs skip the preflight)
 * and doesn't apply to WebSocket handshakes at all — without a check, a
 * malicious page could stop/disconnect the bot or open /ws and read the
 * live log stream.
 *
 * Legitimate browser traffic is the dashboard: in dev it is same-origin
 * with the API via the Vite proxy (browser → :5173 → API), in hosted
 * previews likewise. Non-browser local clients (curl, scripts) send no
 * Origin header and are trusted — they are already running as the user.
 */

type HeaderValue = string | string[] | undefined;

export interface OriginCheckHeaders {
  origin?: HeaderValue;
  host?: HeaderValue;
  "x-forwarded-host"?: HeaderValue;
  "sec-fetch-site"?: HeaderValue;
}

function firstValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value?.split(",")[0]?.trim();
}

/** Extract a lowercase hostname from a URL ("https://x:1/p") or host ("x:1", "[::1]:1"). */
export function hostnameOf(raw: string | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("[")) {
    // Bracketed IPv6, optionally with port: "[::1]" / "[::1]:5000"
    const end = host.indexOf("]");
    if (end <= 0) return null;
    return host.slice(1, end).toLowerCase() || null;
  }
  // Strip ":port" only when there is exactly one colon (bare IPv6 like
  // "::1" must survive intact).
  if ((host.match(/:/g) ?? []).length === 1) {
    const portIdx = host.indexOf(":");
    if (/^\d+$/.test(host.slice(portIdx + 1))) host = host.slice(0, portIdx);
  }
  host = host.toLowerCase();
  return host || null;
}

export function isLocalHostname(hostname: string | null): boolean {
  if (!hostname) return false;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Decide whether a browser-initiated request may proceed. Requests without
 * an Origin header are not browser cross-origin requests (curl, local
 * tooling) and are allowed. Everything else must look like our dashboard:
 * a local origin, a browser-asserted same-origin/same-site fetch, or an
 * origin whose host matches the (possibly proxy-forwarded) request host.
 */
export function isBrowserOriginAllowed(headers: OriginCheckHeaders): boolean {
  const origin = firstValue(headers.origin);
  if (!origin) return true;
  if (origin === "null") return false; // sandboxed iframe / file:// page

  const originHost = hostnameOf(origin);
  if (!originHost) return false;
  if (isLocalHostname(originHost)) return true;

  // Unforgeable by web content; the proxied dashboard is same-origin from
  // the browser's point of view, whatever host the preview uses.
  const fetchSite = firstValue(headers["sec-fetch-site"]);
  if (fetchSite === "same-origin" || fetchSite === "same-site") return true;

  const forwardedHost = hostnameOf(firstValue(headers["x-forwarded-host"]));
  if (forwardedHost && forwardedHost === originHost) return true;
  const host = hostnameOf(firstValue(headers.host));
  if (host && host === originHost) return true;

  return false;
}
