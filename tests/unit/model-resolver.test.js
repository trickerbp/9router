import { describe, expect, it } from "vitest";
import { getModelInfoCore } from "../../open-sse/services/model.js";

describe("getModelInfoCore fallback inference", () => {
  it("routes bare Codex-only GPT models to Codex", async () => {
    await expect(getModelInfoCore("gpt-5.5", {})).resolves.toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("keeps bare OpenAI GPT models on OpenAI", async () => {
    await expect(getModelInfoCore("gpt-5-mini", {})).resolves.toEqual({
      provider: "openai",
      model: "gpt-5-mini",
    });
  });

  it("keeps ambiguous GPT models on OpenAI unless an alias is configured", async () => {
    await expect(getModelInfoCore("gpt-5.4", {})).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("honors explicit aliases before fallback inference", async () => {
    await expect(getModelInfoCore("gpt-5.5", { "gpt-5.5": "openai/gpt-5.4" })).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });
});
