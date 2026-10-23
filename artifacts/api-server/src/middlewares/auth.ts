import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Validates a supplied dashboard token without early-exit string comparison.
 * Returns false when the server has not been configured with a token.
 */
export function isValidDashboardToken(token: string | null | undefined): boolean {
  const expected = process.env["DASHBOARD_TOKEN"]?.trim();
  if (!expected || expected.length < 32 || !token) return false;

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

/**
 * Protects API routes with a bearer token. Fails closed when DASHBOARD_TOKEN
 * is absent so an accidentally unconfigured public deployment cannot be used.
 */
export function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredToken = process.env["DASHBOARD_TOKEN"]?.trim();
  if (!configuredToken || configuredToken.length < 32) {
    res.status(503).json({
      error: "Dashboard access requires a unique DASHBOARD_TOKEN of at least 32 characters.",
    });
    return;
  }

  const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
  if (!match || !isValidDashboardToken(match[1])) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
