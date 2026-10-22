import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { hostnameOf, isBrowserOriginAllowed, isLocalHostname } from "./lib/origin-guard";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The dashboard talks to the API same-origin (dev proxy / same host), so
// CORS only ever matters for cross-origin callers — restrict those to
// pages served from this machine. Anything else gets no CORS headers and
// the browser blocks the read.
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || isLocalHostname(hostnameOf(origin)));
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS can't stop state-changing "simple" requests (form POSTs skip the
// preflight), so mutations additionally require a dashboard-like Origin.
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (!isBrowserOriginAllowed(req.headers)) {
    logger.warn(
      { origin: req.headers.origin, host: req.headers.host, method: req.method, url: req.url },
      "Blocked cross-origin API request",
    );
    res.status(403).json({ error: "Cross-origin request blocked (the API only accepts mutations from the local dashboard)" });
    return;
  }
  next();
});

app.use("/api", router);

// Unknown API routes get a JSON 404 instead of Express' HTML page.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// JSON error responses (instead of Express' default HTML + stack page).
// body-parser failures carry a 4xx `status`; everything else is a 500 with
// a generic message — details go to the server log, never to the client.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { status?: unknown; type?: unknown } | null;
  const status =
    typeof e?.status === "number" && e.status >= 400 && e.status < 500 ? e.status : 500;
  if (status >= 500) {
    logger.error({ err }, "Unhandled API error");
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.status(status).json({
    error: e?.type === "entity.too.large" ? "Request body too large" : "Invalid request body",
  });
});

export default app;
