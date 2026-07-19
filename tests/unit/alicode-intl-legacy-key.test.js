import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { isAlibabaModelStudioKey, resolveAlibabaIntlProvider } from "../../open-sse/providers/shared.js";

describe("Alibaba Intl legacy key compatibility", () => {
  it("recognizes Model Studio keys without misclassifying Coding Plan keys", () => {
    expect(isAlibabaModelStudioKey("sk-standard-key")).toBe(true);
    expect(isAlibabaModelStudioKey(" sk-standard-key ")).toBe(true);
    expect(isAlibabaModelStudioKey("sk-sp-coding-plan-key")).toBe(false);
    expect(isAlibabaModelStudioKey("test-key")).toBe(false);
    expect(resolveAlibabaIntlProvider("alicode-intl", "sk-standard-key")).toBe("alims-intl");
    expect(resolveAlibabaIntlProvider("alicode-intl", "sk-sp-coding-plan-key")).toBe("alicode-intl");
    expect(resolveAlibabaIntlProvider("alicode", "sk-standard-key")).toBe("alicode");
  });

  it("keeps legacy alicode-intl Model Studio connections on the compatible endpoint", () => {
    const executor = new DefaultExecutor("alicode-intl");
    expect(executor.buildUrl("qwen3.5-plus", true, 0, { apiKey: "sk-standard-key" })).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
  });

  it("keeps Coding Plan keys on coding-intl", () => {
    const executor = new DefaultExecutor("alicode-intl");
    expect(executor.buildUrl("qwen3.5-plus", true, 0, { apiKey: "sk-sp-coding-plan-key" })).toBe(
      "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions"
    );
  });

  it("does not change unrelated credentials or the explicit Model Studio provider", () => {
    expect(new DefaultExecutor("alicode-intl").buildUrl("qwen3.5-plus", true, 0, { apiKey: "test-key" })).toBe(
      "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions"
    );
    expect(new DefaultExecutor("alims-intl").buildUrl("qwen3.5-plus", true, 0, { apiKey: "test-key" })).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
  });
});
