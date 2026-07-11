import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("getThinkingLevels", () => {
  it("adds ultra, not max, for gpt-5.6 sol/luna/terra on codex", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      const levels = getThinkingLevels("codex", model);
      expect(levels).toContain("ultra");
      expect(levels).toContain("xhigh");
      expect(levels).not.toContain("max");
    }
  });

  it("does not add max for other codex models", () => {
    const levels = getThinkingLevels("codex", "gpt-5.3-codex");
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not add max or ultra for gpt-5.5", () => {
    const levels = getThinkingLevels("codex", "gpt-5.5");
    expect(levels || []).not.toContain("max");
    expect(levels || []).not.toContain("ultra");
    expect(levels || []).toContain("xhigh");
  });
});
