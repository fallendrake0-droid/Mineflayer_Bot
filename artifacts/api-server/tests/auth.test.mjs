import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isValidDashboardToken,
  requireDashboardAuth,
} from "../src/middlewares/auth.ts";

const originalToken = process.env["DASHBOARD_TOKEN"];

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env["DASHBOARD_TOKEN"];
  } else {
    process.env["DASHBOARD_TOKEN"] = originalToken;
  }
});

function makeRequest(authorization) {
  return {
    get(name) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test("token validation fails closed when no token or a weak token is configured", () => {
  delete process.env["DASHBOARD_TOKEN"];
  assert.equal(isValidDashboardToken("some-token"), false);
  process.env["DASHBOARD_TOKEN"] = "short-token";
  assert.equal(isValidDashboardToken("short-token"), false);
  assert.equal(isValidDashboardToken(undefined), false);
});

test("token validation accepts the exact configured token only", () => {
  process.env["DASHBOARD_TOKEN"] = "ci-dashboard-token-not-for-production";
  assert.equal(isValidDashboardToken("ci-dashboard-token-not-for-production"), true);
  assert.equal(isValidDashboardToken("wrong-secret"), false);
  assert.equal(isValidDashboardToken(" ci-dashboard-token-not-for-production "), false);
});

test("auth middleware returns 503 when not configured", () => {
  delete process.env["DASHBOARD_TOKEN"];
  const response = makeResponse();
  let calledNext = false;

  requireDashboardAuth(makeRequest("Bearer ci-dashboard-token-not-for-production"), response, () => {
    calledNext = true;
  });

  assert.equal(response.statusCode, 503);
  assert.equal(calledNext, false);
  assert.match(response.body.error, /DASHBOARD_TOKEN/i);
});

test("auth middleware rejects missing and incorrect bearer tokens", () => {
  process.env["DASHBOARD_TOKEN"] = "ci-dashboard-token-not-for-production";

  for (const authorization of [undefined, "", "Basic test-secret", "Bearer wrong"]) {
    const response = makeResponse();
    let calledNext = false;

    requireDashboardAuth(makeRequest(authorization), response, () => {
      calledNext = true;
    });

    assert.equal(response.statusCode, 401, String(authorization));
    assert.equal(calledNext, false, String(authorization));
    assert.deepEqual(response.body, { error: "Unauthorized" });
  }
});

test("auth middleware allows a valid bearer token", () => {
  process.env["DASHBOARD_TOKEN"] = "ci-dashboard-token-not-for-production";
  const response = makeResponse();
  let calledNext = false;

  requireDashboardAuth(makeRequest("Bearer ci-dashboard-token-not-for-production"), response, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, undefined);
});
