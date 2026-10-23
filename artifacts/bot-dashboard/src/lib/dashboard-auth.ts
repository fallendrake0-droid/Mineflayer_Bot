export const DASHBOARD_TOKEN_STORAGE_KEY = "minecontrol.dashboardToken";

export function getStoredDashboardToken(): string | null {
  try {
    return window.sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Optional API origin for separately hosted dashboard/API deployments.
 * Set VITE_API_BASE_URL to an origin such as https://api.example.com.
 * No credentials or secret values belong in VITE_ variables.
 */
export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!configured) return "";

  const parsed = new URL(configured);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("VITE_API_BASE_URL must be an HTTP(S) origin without a path, query, or credentials");
  }

  return parsed.origin;
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}

export function getDashboardWebSocketUrl(): string {
  const base = getApiBaseUrl() || window.location.origin;
  const target = new URL("/ws", base);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}
