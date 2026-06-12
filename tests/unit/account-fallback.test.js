import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("account fallback error classification", () => {
  it("does not fan out auth-revoked errors to the next account", () => {
    expect(checkFallbackError(401, "Token invalid or revoked")).toMatchObject({
      shouldFallback: false,
      shouldMarkUnavailable: true,
      scope: "account",
    });
  });

  it("falls back on quota and rate-limit errors", () => {
    expect(checkFallbackError(403, "usage_limit_reached")).toMatchObject({
      shouldFallback: true,
      shouldMarkUnavailable: true,
    });
    expect(checkFallbackError(429, "Rate limit exceeded")).toMatchObject({
      shouldFallback: true,
      shouldMarkUnavailable: true,
    });
  });

  it("does not mutate account state for request/model mistakes", () => {
    expect(checkFallbackError(400, "Bad request")).toMatchObject({
      shouldFallback: false,
      shouldMarkUnavailable: false,
    });
    expect(checkFallbackError(404, "Model not found")).toMatchObject({
      shouldFallback: false,
      shouldMarkUnavailable: false,
    });
  });

  it("falls back on transient upstream failures", () => {
    expect(checkFallbackError(502, "fetch failed")).toMatchObject({
      shouldFallback: true,
      shouldMarkUnavailable: true,
    });
  });
});
