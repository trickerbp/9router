import { describe, expect, it } from "vitest";
import {
  getProviderIconSrc,
  markProviderIconMissing,
  resolveProviderIconId,
} from "../../src/shared/utils/providerIcon.js";

describe("provider icon resolution", () => {
  it("maps provider aliases to existing icon assets", () => {
    expect(getProviderIconSrc("perplexity-agent")).toBe("/providers/perplexity.png");
    expect(getProviderIconSrc("vercel-ai-gateway")).toBe("/providers/vercel.png");
  });

  it("caches missing provider ids for the rest of the session", () => {
    expect(resolveProviderIconId("missing-test-provider")).toBe("missing-test-provider");
    markProviderIconMissing("missing-test-provider");
    expect(getProviderIconSrc("missing-test-provider")).toBeNull();
  });

  it("caches both the provider id and its aliased asset id", () => {
    markProviderIconMissing("gitlab-duo");
    expect(getProviderIconSrc("gitlab-duo")).toBeNull();
    expect(getProviderIconSrc("gitlab")).toBeNull();
  });
});
