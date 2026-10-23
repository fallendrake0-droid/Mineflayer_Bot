export const DASHBOARD_TOKEN_STORAGE_KEY = "minecontrol.dashboardToken";

export function getStoredDashboardToken(): string | null {
  try {
    return window.sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}
