import { describe, expect, it } from "vitest";
import { resolveNativeCliFallbackProvider } from "../../open-sse/utils/nativeModelRouting.js";

const claudeCode = { endpoint: "/v1/messages", clientTool: "claude" };

describe("native CLI provider fallback", () => {
  it("falls back from anthropic to claude for a bare Claude Code model", () => {
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      ...claudeCode,
    })).toBe("claude");
  });

  it("covers the dashboard-mounted path and count_tokens subroute", () => {
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      endpoint: "/api/v1/messages",
      clientTool: "claude",
    })).toBe("claude");
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-opus-5",
      endpoint: "/v1/messages/count_tokens",
      clientTool: "claude",
    })).toBe("claude");
  });

  it("does not apply when the provider was explicit rather than inferred", () => {
    // An explicit `cc/` or `claude/` prefix resolves to provider "claude" already,
    // and an explicit `anthropic/` prefix is a deliberate choice — neither is a guess.
    expect(resolveNativeCliFallbackProvider({
      provider: "claude",
      model: "claude-sonnet-5",
      ...claudeCode,
    })).toBeNull();
  });

  it("does not apply to other clients, endpoints, or model families", () => {
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      endpoint: "/v1/messages",
      clientTool: null,
    })).toBeNull();
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      endpoint: "/v1/chat/completions",
      clientTool: "claude",
    })).toBeNull();
    expect(resolveNativeCliFallbackProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      endpoint: "/v1/messages",
      clientTool: "codex",
    })).toBeNull();
    expect(resolveNativeCliFallbackProvider({
      provider: "codex",
      model: "gpt-5.6-sol",
      endpoint: "/v1/responses",
      clientTool: "codex",
    })).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    expect(resolveNativeCliFallbackProvider({})).toBeNull();
    expect(resolveNativeCliFallbackProvider({ provider: "anthropic", model: null, ...claudeCode })).toBeNull();
    expect(resolveNativeCliFallbackProvider()).toBeNull();
  });
});
