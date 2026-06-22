import { describe, expect, it } from "vitest";

import { hasBlockingAuthError } from "@/sse/services/auth.js";

const RECOVERY_MS = 10 * 60 * 1000;

describe("hasBlockingAuthError recovery window", () => {
  it("blocks a recent auth error", () => {
    expect(hasBlockingAuthError({
      testStatus: "error",
      lastError: "Token expired",
      lastErrorAt: new Date().toISOString(),
    })).toBe(true);
  });

  it("allows retry once the recovery window has elapsed (transient 401 self-heals)", () => {
    expect(hasBlockingAuthError({
      testStatus: "error",
      lastError: "refresh failed",
      lastErrorAt: new Date(Date.now() - RECOVERY_MS - 1000).toISOString(),
    })).toBe(false);
  });

  it("does not block non-auth errors", () => {
    expect(hasBlockingAuthError({
      testStatus: "unavailable",
      lastError: "rate limit exceeded",
      lastErrorAt: new Date().toISOString(),
    })).toBe(false);
  });

  it("does not block active connections", () => {
    expect(hasBlockingAuthError({
      testStatus: "active",
      lastError: "token invalid",
      lastErrorAt: new Date().toISOString(),
    })).toBe(false);
  });

  it("blocks indefinitely when lastErrorAt is missing (cannot prove staleness)", () => {
    expect(hasBlockingAuthError({
      testStatus: "error",
      lastError: "invalid or revoked",
    })).toBe(true);
  });
});
