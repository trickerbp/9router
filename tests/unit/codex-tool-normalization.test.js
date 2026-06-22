import { describe, expect, it } from "vitest";

import { CodexExecutor } from "open-sse/executors/codex.js";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };
  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-tools",
    providerSpecificData: {},
  });
  return body.tools;
}

describe("CodexExecutor tool normalization", () => {
  it("preserves Responses-native custom (freeform) tools like apply_patch", () => {
    const out = normalizeTools([
      { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: ..." } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("custom");
    expect(out[0].name).toBe("apply_patch");
  });

  it("preserves hosted tool_search tools", () => {
    const out = normalizeTools([{ type: "tool_search", execution: "sync", description: "discover" }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool_search");
  });

  it("still normalizes plain function tools", () => {
    const out = normalizeTools([
      { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("function");
    expect(out[0].name).toBe("get_weather");
  });
});
