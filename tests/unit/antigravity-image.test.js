import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";

describe("Antigravity image generation", () => {
  const ex = new AntigravityExecutor();

  it("routes image models to non-streaming generateContent", () => {
    expect(ex.buildUrl("gemini-3.1-flash-image", true)).toContain(":generateContent");
    expect(ex.buildUrl("gemini-3.1-flash-image", true)).not.toContain("streamGenerateContent");
  });

  it("keeps streaming for non-image models", () => {
    expect(ex.buildUrl("gemini-3-flash-agent", true)).toContain("streamGenerateContent");
  });

  it("builds image_gen request envelope with imageConfig", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "a cat" }] }] };
    const out = ex.transformRequest("gemini-3.1-flash-image", body, false, { connectionId: "c1", projectId: "p1" });
    expect(out.requestType).toBe("image_gen");
    expect(out.model).toBe("gemini-3.1-flash-image");
    expect(out.request.generationConfig.imageConfig.aspectRatio).toBe("1:1");
    expect(out.request.contents[0].parts[0].text).toBe("a cat");
  });

  it("derives aspect ratio from resolution suffix", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "x" }] }] };
    const out = ex.transformRequest("gemini-3.1-flash-image-16x9", body, false, { connectionId: "c1" });
    expect(out.model).toBe("gemini-3.1-flash-image");
    expect(out.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
  });
});
