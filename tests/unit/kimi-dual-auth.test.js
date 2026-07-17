import { beforeEach, describe, expect, it, vi } from "vitest";

const dbAll = vi.hoisted(() => vi.fn(() => []));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ all: dbAll })),
}));

import kimi from "../../open-sse/providers/registry/kimi.js";
import { buildKimiHeaders } from "../../open-sse/config/appConstants.js";
import { refreshKimiToken } from "../../open-sse/services/tokenRefresh/providers.js";
import { getProviderConnections } from "../../src/lib/db/repos/connectionsRepo.js";
import { getProviderByAlias, resolveProviderId } from "../../src/shared/constants/providers.js";

describe("Kimi dual-auth compatibility", () => {
  beforeEach(() => {
    dbAll.mockClear();
  });

  it("resolves former kimi-coding aliases to the merged provider", () => {
    expect(getProviderByAlias("kimi-coding")?.id).toBe("kimi");
    expect(getProviderByAlias("kmc")?.id).toBe("kimi");
    expect(resolveProviderId("kimi-coding")).toBe("kimi");
  });

  it("keeps legacy stored connections visible from the kimi provider", async () => {
    await getProviderConnections({ provider: "kimi", isActive: true });
    expect(dbAll).toHaveBeenCalledWith(
      expect.stringContaining("provider IN (?, ?)"),
      ["kimi", "kimi-coding", 1],
    );
  });

  it("publishes both auth modes and the new K3/K2.7 model family", () => {
    expect(kimi.authModes).toEqual(["oauth", "apikey"]);
    expect(kimi.aliases).toEqual(expect.arrayContaining(["kimi-coding", "kmc"]));
    expect(kimi.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "kimi-k3",
      "k3",
      "kimi-k2.7-code",
      "kimi-for-coding",
    ]));
  });

  it("reuses the persisted device id in Kimi headers and refresh calls", async () => {
    const headers = buildKimiHeaders("stable-device-id");
    expect(headers["X-Msh-Device-Id"]).toBe("stable-device-id");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    try {
      const refreshed = await refreshKimiToken("old-refresh", {
        providerSpecificData: { deviceId: "stable-device-id" },
      });
      expect(refreshed).toEqual(expect.objectContaining({ accessToken: "new-access" }));
      const [, init] = globalThis.fetch.mock.calls[0];
      expect(init.headers["X-Msh-Device-Id"]).toBe("stable-device-id");
      expect(String(init.body)).toContain("client_id=");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
