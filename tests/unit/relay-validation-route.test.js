import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;

function mockNextServer() {
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
}

describe("relay API-key validation route", () => {
  let tempDir;
  let POST;
  let createProviderConnection;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-relay-validation-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    mockNextServer();
    ({ POST } = await import("../../src/app/api/providers/validate/route.js"));
    ({ createProviderConnection } = await import("../../src/models/index.js"));
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  const request = (body) => new Request("https://9router.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("probes Claude's real messages endpoint with the registry default model", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await POST(request({
      provider: "claude",
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: "https://relay.test/v1" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ valid: true, error: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://relay.test/v1/messages");
    expect(options.headers.Authorization).toBe("Bearer sk-test");
    expect(options.headers["x-api-key"]).toBe("sk-test");
    expect(JSON.parse(options.body).model).toBe("claude-opus-5");
  });

  it("reports relay inference failures, including rate limits, as invalid", async () => {
    global.fetch.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "upstream rate limit" } }),
      { status: 429 },
    ));
    const response = await POST(request({
      provider: "codex",
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: "https://relay.test/v1" },
    }));
    expect(await response.json()).toEqual({
      valid: false,
      error: "Relay returned HTTP 429: upstream rate limit",
    });
  });

  it("loads the existing key when Edit Connection leaves API Key blank", async () => {
    const connection = await createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "ZenAPI",
      apiKey: "sk-stored",
      providerSpecificData: { baseUrl: "https://old.example/v1" },
      isActive: true,
    });
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(request({
      provider: "claude",
      connectionId: connection.id,
      providerSpecificData: { baseUrl: "https://new.example/v1" },
    }));
    expect(await response.json()).toEqual({ valid: true, error: null });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer sk-stored");
    expect(options.headers["x-api-key"]).toBe("sk-stored");
    expect(global.fetch.mock.calls[0][0]).toBe("https://new.example/v1/messages");
  });

  it("uses the model selected in Edit Connection instead of a registry default", async () => {
    const connection = await createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "ZenAPI",
      apiKey: "sk-stored",
      defaultModel: "old-model",
      providerSpecificData: { baseUrl: "https://relay.test/v1" },
      isActive: true,
    });
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(request({
      provider: "claude",
      connectionId: connection.id,
      defaultModel: "claude-selected-for-test",
      providerSpecificData: { baseUrl: "https://relay.test/v1" },
    }));

    expect(await response.json()).toEqual({ valid: true, error: null });
    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body).model).toBe("claude-selected-for-test");
  });

  it("validates a Claude key against the official endpoint when the relay is cleared", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await POST(request({
      provider: "claude",
      apiKey: "sk-direct",
      providerSpecificData: { baseUrl: "" },
    }));
    expect(await response.json()).toEqual({ valid: true, error: null });
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("rejects a connectionId that belongs to another provider or auth mode", async () => {
    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "OAuth",
      accessToken: "oauth-token",
      isActive: true,
    });
    const response = await POST(request({
      provider: "claude",
      connectionId: connection.id,
      providerSpecificData: { baseUrl: "https://relay.test/v1" },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A matching API-key connection is required" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
