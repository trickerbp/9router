import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: mocks.refreshCodexToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

const originalFetch = globalThis.fetch;

async function loadModels() {
  const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
  const response = await GET(null, { params: Promise.resolve({ id: "codex-connection" }) });
  return response.json();
}

describe("Codex model sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "codex-connection",
      provider: "codex",
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the current client version and official originator header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock;

    const body = await loadModels();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.144.6",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer old-access",
          originator: "codex_cli_rs",
        }),
      })
    );
    expect(body.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol-review"]);
  });

  it("refreshes and persists Codex credentials before retrying auth failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock;
    mocks.refreshCodexToken.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });

    const body = await loadModels();

    expect(mocks.refreshCodexToken).toHaveBeenCalledWith("old-refresh");
    expect(mocks.updateProviderCredentials).toHaveBeenCalledWith("codex-connection", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
    expect(body.models).toHaveLength(2);
  });

  it("returns a warning when Codex responds successfully with an empty catalog", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const body = await loadModels();

    expect(body.models).toEqual([]);
    expect(body.warning).toBe("Failed to fetch Codex models: upstream returned no models");
  });
});
