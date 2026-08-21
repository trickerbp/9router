// Locks the per-connection relay Base URL override for the first-party CLI
// providers (claude/codex): the host comes from the connection, the request
// shape and identity headers stay first-party, and the credential is sent under
// both auth schemes. See open-sse/providers/relay.js for the rationale.
import { describe, it, expect } from "vitest";

const { normalizeRelayBaseUrl, resolveRelayUrl, supportsRelayBaseUrl } = await import(
  "../../open-sse/providers/relay.js"
);
const { getExecutor } = await import("../../open-sse/executors/index.js");

const relayCreds = (baseUrl, apiKey = "sk-relay-key") => ({
  apiKey,
  providerSpecificData: { baseUrl },
});

describe("relay base URL normalization", () => {
  it("only claude and codex opt in", () => {
    expect(supportsRelayBaseUrl("claude")).toBe(true);
    expect(supportsRelayBaseUrl("codex")).toBe(true);
    expect(supportsRelayBaseUrl("openai")).toBe(false);
    expect(supportsRelayBaseUrl(undefined)).toBe(false);
  });

  it("resolves a pasted root, trailing slash and full endpoint identically", () => {
    for (const input of [
      "https://relay.example/v1",
      "https://relay.example/v1/",
      "https://relay.example/v1/messages",
      "  https://relay.example/v1  ",
    ]) {
      expect(normalizeRelayBaseUrl("claude", input)).toBe("https://relay.example/v1");
    }
    expect(normalizeRelayBaseUrl("codex", "https://relay.example/v1/responses")).toBe(
      "https://relay.example/v1"
    );
  });

  it("treats blank and unsupported providers as no override", () => {
    expect(normalizeRelayBaseUrl("claude", "   ")).toBeNull();
    expect(normalizeRelayBaseUrl("claude", null)).toBeNull();
    expect(normalizeRelayBaseUrl("openai", "https://relay.example/v1")).toBeNull();
    expect(resolveRelayUrl("claude", { providerSpecificData: {} })).toBeNull();
  });

  it("does not require or invent /v1 — the pasted path is used verbatim", () => {
    expect(resolveRelayUrl("claude", relayCreds("https://relay.example"))).toBe(
      "https://relay.example/messages"
    );
    expect(resolveRelayUrl("codex", relayCreds("https://relay.example/"))).toBe(
      "https://relay.example/responses"
    );
    expect(resolveRelayUrl("claude", relayCreds("https://relay.example/api/anthropic"))).toBe(
      "https://relay.example/api/anthropic/messages"
    );
    expect(resolveRelayUrl("claude", relayCreds("https://relay.example/v1"))).toBe(
      "https://relay.example/v1/messages"
    );
  });
});

describe("claude relay routing", () => {
  const exec = getExecutor("claude");

  it("sends /messages on the relay host without the anthropic ?beta flag", () => {
    const url = exec.buildUrl("claude-opus-5", true, 0, relayCreds("https://relay.example/v1"));
    expect(url).toBe("https://relay.example/v1/messages");
  });

  it("still uses the official endpoint when no relay is configured", () => {
    const url = exec.buildUrl("claude-opus-5", true, 0, { apiKey: "sk-ant-direct" });
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("sends the key as both x-api-key and bearer, keeping Claude Code identity", () => {
    const headers = exec.buildHeaders(
      relayCreds("https://relay.example/v1"),
      true,
      "https://relay.example/v1/messages",
      "claude-opus-5"
    );
    expect(headers["x-api-key"]).toBe("sk-relay-key");
    expect(headers.Authorization).toBe("Bearer sk-relay-key");
    expect(headers["Anthropic-Beta"]).toContain("claude-code-20250219");
    expect(headers["X-App"]).toBe("cli");
  });

  it("leaves a direct Anthropic key on x-api-key only", () => {
    const headers = exec.buildHeaders({ apiKey: "sk-ant-direct" }, true, "", "claude-opus-5");
    expect(headers["x-api-key"]).toBe("sk-ant-direct");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("codex relay routing", () => {
  const exec = getExecutor("codex");

  it("sends /responses on the relay host", () => {
    const url = exec.buildUrl("gpt-5.5", true, 0, relayCreds("https://relay.example/v1"));
    expect(url).toBe("https://relay.example/v1/responses");
  });

  it("still uses the ChatGPT backend when no relay is configured", () => {
    const url = exec.buildUrl("gpt-5.5", true, 0, { accessToken: "oauth-token" });
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("sends the key as both bearer and x-api-key, keeping the codex originator", () => {
    const headers = exec.buildHeaders(relayCreds("https://relay.example/v1"), true);
    expect(headers.Authorization).toBe("Bearer sk-relay-key");
    expect(headers["x-api-key"]).toBe("sk-relay-key");
    expect(headers.originator).toBe("codex_cli_rs");
  });
});

describe("non-relay providers are untouched", () => {
  it("ignores a stray baseUrl in providerSpecificData", () => {
    const exec = getExecutor("openai");
    const url = exec.buildUrl("gpt-4o", true, 0, relayCreds("https://relay.example/v1"));
    expect(url).not.toContain("relay.example");
  });
});
