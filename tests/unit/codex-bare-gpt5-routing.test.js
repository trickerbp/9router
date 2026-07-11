import { describe, expect, it } from "vitest";

import { getModelInfoCore, parseModel } from "../../open-sse/services/model.js";

describe("bare gpt-5 model routing", () => {
  it.each([
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-preview",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.7-preview",
  ])("routes bare %s to Codex", async (model) => {
    await expect(getModelInfoCore(model, {})).resolves.toEqual({
      provider: "codex",
      model,
    });
  });

  it("keeps explicit provider prefixes unchanged", () => {
    expect(parseModel("cx/gpt-5.6-sol")).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      providerAlias: "cx",
    });
    expect(parseModel("openai/gpt-5.6-sol")).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      providerAlias: "openai",
    });
  });

  it("does not move older bare OpenAI GPT models", async () => {
    await expect(getModelInfoCore("gpt-4.1", {})).resolves.toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    await expect(getModelInfoCore("gpt-50", {})).resolves.toEqual({
      provider: "openai",
      model: "gpt-50",
    });
  });
});
