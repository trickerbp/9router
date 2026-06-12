import { describe, expect, it } from "vitest";
import {
  buildKiroQUrl,
  resolveKiroOidcRegion,
  resolveKiroRegion,
} from "../../open-sse/services/kiroRegion.js";

describe("Kiro region resolution", () => {
  it("keeps Kiro runtime region separate from OIDC refresh region", () => {
    const durableJson = {
      region: "eu-central-1",
      oidc_region: "us-east-1",
      profile_arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example",
    };

    expect(resolveKiroRegion(durableJson)).toBe("eu-central-1");
    expect(resolveKiroOidcRegion(durableJson)).toBe("us-east-1");
    expect(buildKiroQUrl(durableJson, "generateAssistantResponse"))
      .toBe("https://q.eu-central-1.amazonaws.com/generateAssistantResponse");
  });
});
