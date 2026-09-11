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

function request(body) {
  return new Request("https://dashboard.example/api/provider-nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("compatible provider setup", () => {
  let tempDir;

  beforeEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-setup-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    mockNextServer();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global.fetch = originalFetch;
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("saves the OpenAI-compatible key and selected model as the initial connection", async () => {
    const { POST } = await import("@/app/api/provider-nodes/route.js");
    const { getProviderConnections } = await import("@/models/index.js");

    const response = await POST(request({
      type: "openai-compatible",
      name: "Gateway",
      prefix: "gw",
      apiType: "responses",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-gateway",
      modelId: "gpt-5.6-sol",
    }));
    const body = await response.json();
    const connections = await getProviderConnections({ provider: body.node.id });

    expect(response.status).toBe(201);
    expect(body.connection.apiKey).toBeUndefined();
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      provider: body.node.id,
      apiKey: "sk-gateway",
      defaultModel: "gpt-5.6-sol",
      providerSpecificData: {
        baseUrl: "https://gateway.example/v1",
        apiType: "responses",
        prefix: "gw",
      },
    });
  });

  it("checks an OpenAI-compatible chat model by inference instead of /models", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/provider-nodes/validate/route.js");

    const response = await POST(request({
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-gateway",
      modelId: "chosen-model",
    }));

    expect(await response.json()).toEqual({ valid: true, method: "chat" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: "chosen-model" });
  });

  it("checks an Anthropic-compatible model at its messages endpoint", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/provider-nodes/validate/route.js");

    const response = await POST(request({
      type: "anthropic-compatible",
      baseUrl: "https://gateway.example/v1/messages",
      apiKey: "sk-gateway",
      modelId: "claude-selected",
    }));

    expect(await response.json()).toEqual({ valid: true, method: "messages" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://gateway.example/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: "claude-selected" });
  });

  it("requires a model selection before checking a compatible provider", async () => {
    const { POST } = await import("@/app/api/provider-nodes/validate/route.js");

    const response = await POST(request({
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-gateway",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Model ID is required to check this provider" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
