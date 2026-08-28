import { describe, expect, it, vi } from "vitest";
import {
  buildRelayProbeRequest,
  probeRelayConnection,
  selectRelayProbeModel,
} from "../../open-sse/providers/relayProbe.js";

describe("relay connection probe", () => {
  it("builds the Claude Code wire request with both auth schemes", () => {
    const request = buildRelayProbeRequest({
      provider: "claude",
      baseUrl: "https://relay.test/v1/",
      apiKey: "sk-test",
      model: "claude-sonnet-5",
    });
    expect(request.url).toBe("https://relay.test/v1/messages");
    expect(request.options.headers["x-api-key"]).toBe("sk-test");
    expect(request.options.headers.Authorization).toBe("Bearer sk-test");
    expect(request.options.headers["X-App"]).toBe("cli");
    expect(JSON.parse(request.options.body)).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 1,
      stream: false,
    });
  });

  it("builds the Codex Responses wire request with identity headers", () => {
    const request = buildRelayProbeRequest({
      provider: "codex",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
    });
    expect(request.url).toBe("https://relay.test/v1/responses");
    expect(request.options.headers.Authorization).toBe("Bearer sk-test");
    expect(request.options.headers["x-api-key"]).toBe("sk-test");
    expect(request.options.headers.originator).toBe("codex_cli_rs");
    expect(JSON.parse(request.options.body)).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
    });
  });

  it("uses the registry default when no per-connection model is supplied", () => {
    const request = buildRelayProbeRequest({
      provider: "claude",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
    });
    expect(request.model).toBe("claude-opus-5");
    expect(JSON.parse(request.options.body).model).toBe("claude-opus-5");
  });

  it("strips local provider prefixes before sending the upstream model", () => {
    const claudeRequest = buildRelayProbeRequest({
      provider: "claude",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      preferredModel: "cc/claude-sonnet-5",
    });
    const codexRequest = buildRelayProbeRequest({
      provider: "codex",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      preferredModel: "cx/gpt-5.6-sol",
    });
    expect(claudeRequest.model).toBe("claude-sonnet-5");
    expect(codexRequest.model).toBe("gpt-5.6-sol");
  });

  it("prefers a configured model when selecting from an optional catalog", () => {
    const catalog = { data: [{ id: "cc/claude-sonnet-5" }, { id: "cx/gpt-5.6-sol" }] };
    expect(selectRelayProbeModel("claude", catalog, "claude-opus-5")).toBe("claude-opus-5");
    expect(selectRelayProbeModel("codex", catalog)).toBe("cx/gpt-5.6-sol");
  });

  it("accepts a successful real inference response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(probeRelayConnection({
      provider: "claude",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      fetchFn,
    })).resolves.toMatchObject({ valid: true, status: 200, model: "claude-sonnet-5" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("https://relay.test/v1/messages");
  });

  it.each([
    [404, "not found"],
    [429, "rate limit"],
  ])("rejects HTTP %s and returns the upstream message", async (status, message) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message } }),
      { status },
    ));
    await expect(probeRelayConnection({
      provider: "codex",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchFn,
    })).resolves.toMatchObject({
      valid: false,
      status,
      error: `Relay returned HTTP ${status}: ${message}`,
    });
  });

  it("reports network failures without exposing the credential", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect failed"));
    await expect(probeRelayConnection({
      provider: "claude",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-secret",
      model: "claude-sonnet-5",
      fetchFn,
    })).resolves.toMatchObject({ valid: false, error: "Relay unreachable: connect failed" });
  });

  it.each([
    ["content-type", "<p>ok</p>", { "content-type": "text/html; charset=utf-8" }],
    ["body sniff", "<!doctype html><html></html>", { "content-type": "application/octet-stream" }],
  ])("rejects an HTML 200 detected by %s — the Base URL is missing its API prefix", async (_label, body, headers) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers }));
    const result = await probeRelayConnection({
      provider: "claude",
      baseUrl: "https://relay.test",
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      fetchFn,
    });
    expect(result.valid).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toContain("HTML page");
    expect(result.error).toContain("/v1");
  });

  it("still accepts a JSON 200 from a correctly suffixed relay", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ type: "message", content: [{ type: "text", text: "pong" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(probeRelayConnection({
      provider: "claude",
      baseUrl: "https://relay.test/v1",
      apiKey: "sk-test",
      model: "claude-sonnet-5",
      fetchFn,
    })).resolves.toMatchObject({ valid: true, status: 200 });
  });
});
