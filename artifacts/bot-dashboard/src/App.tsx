import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Home } from "@/pages/Home";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import {
  DASHBOARD_TOKEN_STORAGE_KEY,
  getStoredDashboardToken,
  getApiBaseUrl,
  apiUrl,
} from "@/lib/dashboard-auth";

// The API client reads the token only when a request is made. The token is
// session-scoped and is never embedded into the frontend bundle.
setBaseUrl(getApiBaseUrl() || null);
setAuthTokenGetter(() => getStoredDashboardToken());

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function DashboardAccessGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const saved = getStoredDashboardToken();

    if (!saved) {
      setChecking(false);
      return () => {
        cancelled = true;
      };
    }

    setToken(saved);
    fetch(apiUrl("/api/auth/verify"), {
      method: "POST",
      headers: { Authorization: `Bearer ${saved}` },
    })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) {
          setAuthenticated(true);
          return;
        }
        try {
          window.sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE_KEY);
        } catch {
          // The access form remains available if storage is blocked.
        }
        setToken("");
        setError(
          response.status === 503
            ? "Dashboard access is not configured on the server. Set DASHBOARD_TOKEN first."
            : "The saved dashboard token was rejected. Enter the correct token.",
        );
      })
      .catch(() => {
        if (!cancelled) setError("Could not contact the API server. Check that it is running.");
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError("Enter the dashboard token.");
      return;
    }

    setChecking(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/auth/verify"), {
        method: "POST",
        headers: { Authorization: `Bearer ${candidate}` },
      });
      if (!response.ok) {
        setError(
          response.status === 503
            ? "Dashboard access is not configured on the server. Set DASHBOARD_TOKEN first."
            : "Token rejected. Check the server's DASHBOARD_TOKEN value.",
        );
        return;
      }

      try {
        window.sessionStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, candidate);
      } catch {
        setError("Browser session storage is unavailable; the dashboard cannot keep the token for API requests.");
        return;
      }
      setAuthenticated(true);
    } catch {
      setError("Could not contact the API server. Check that it is running.");
    } finally {
      setChecking(false);
    }
  };

  if (authenticated) return <>{children}</>;

  if (checking) {
    return (
      <main className="min-h-[100dvh] bg-background text-foreground grid place-items-center p-6">
        <p className="font-mono text-sm text-muted-foreground">VERIFYING_DASHBOARD_ACCESS...</p>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background text-foreground grid place-items-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-4 rounded-lg border border-primary/30 bg-black p-6 shadow-lg">
        <h1 className="font-mono text-xl font-bold text-primary">MINECONTROL_ACCESS</h1>
        <p className="text-sm text-muted-foreground">
          Enter the server-side DASHBOARD_TOKEN. It is held in this browser session only.
          Use HTTPS when accessing the dashboard over a network.
        </p>
        <label htmlFor="dashboard-token" className="block font-mono text-xs text-muted-foreground">
          DASHBOARD TOKEN
        </label>
        <input
          id="dashboard-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="w-full rounded border border-primary/30 bg-card px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          placeholder="Paste your token"
          required
        />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={checking}
          className="w-full rounded bg-primary px-3 py-2 font-mono text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {checking ? "VERIFYING..." : "UNLOCK_DASHBOARD"}
        </button>
      </form>
    </main>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DashboardAccessGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </DashboardAccessGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
