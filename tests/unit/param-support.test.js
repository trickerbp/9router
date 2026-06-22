import { describe, expect, it } from "vitest";

import { stripUnsupportedParams } from "open-sse/translator/helpers/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("drops deprecated temperature for claude-opus-4 models", () => {
    const body = { temperature: 0.7, max_tokens: 100 };
    stripUnsupportedParams("claude", "claude-opus-4-8", body);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(100);
  });

  it("keeps temperature for non-opus-4 models", () => {
    const body = { temperature: 0.7 };
    stripUnsupportedParams("claude", "claude-sonnet-4-6", body);
    expect(body.temperature).toBe(0.7);
  });

  it("is a no-op when model/body missing", () => {
    expect(stripUnsupportedParams("claude", "", { temperature: 1 })).toEqual({ temperature: 1 });
    expect(stripUnsupportedParams("claude", "claude-opus-4-8", null)).toBeNull();
  });
});
