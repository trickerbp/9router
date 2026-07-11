import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

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
  it("normalizes GPT-5.6 message content for Codex backend", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_text", text: "world" },
          ],
        },
      ],
      stream: true,
    };

    executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-56-content",
      providerSpecificData: {},
    });

    expect(body.input).toEqual([
      { type: "message", role: "user", content: "hello\nworld" },
    ]);
  });

  it("preserves GPT-5.6 VS Code additional_tools without unsupported content", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          content: [{ type: "input_text", text: "ignored" }],
          status: "completed",
          tools: [
            {
              type: "tool_search",
              execution: "sync",
              description: "Discover deferred tools",
              parameters: { type: "object", properties: {} },
            },
            {
              type: "custom",
              name: "exec",
              description: "Run JavaScript code",
              format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
            },
          ],
        },
      ],
      stream: true,
    };

    executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-additional-tools",
      providerSpecificData: {},
    });

    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "tool_search",
            execution: "client",
            description: "Discover deferred tools",
            parameters: { type: "object", properties: {} },
          },
          {
            type: "custom",
            name: "exec",
            description: "Run JavaScript code",
            format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
          },
        ],
      },
    ]);
    expect(body.input[0].content).toBeUndefined();
    expect(body.input[0].status).toBeUndefined();
  });

  it("preserves GPT-5.6 native tool-call history items", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_custom",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
          id: "ctc_1",
          status: "completed",
          created_by: "model",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_custom",
          output: [{ type: "input_text", text: "patch applied" }],
          id: "ctco_1",
          status: "completed",
        },
        {
          type: "apply_patch_call",
          call_id: "call_patch",
          operation: { type: "update_file", path: "src/a.js", diff: "@@\n" },
          status: "completed",
          id: "apc_1",
        },
        {
          type: "apply_patch_call_output",
          call_id: "call_patch",
          output: "Done",
          id: "apco_1",
        },
        {
          type: "shell_call",
          call_id: "call_shell",
          action: { commands: ["git diff"], timeout_ms: 1000 },
          status: "completed",
          id: "sh_1",
        },
        {
          type: "shell_call_output",
          call_id: "call_shell",
          output: [
            {
              stdout: "clean",
              stderr: "",
              outcome: { type: "exit", exit_code: 0 },
            },
          ],
          max_output_length: 1000,
          status: "completed",
          id: "sho_1",
        },
        { type: "custom_tool_call_output", output: "missing call id" },
        { type: "unsupported_codex_item", call_id: "drop" },
      ],
      stream: true,
    };

    executor.transformRequest("gpt-5.6-sol", body, true, {
      connectionId: "test-codex-56-tool-history",
      providerSpecificData: {},
    });

    expect(body.input).toEqual([
      {
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: "patch applied",
      },
      {
        type: "apply_patch_call",
        call_id: "call_patch",
        operation: { type: "update_file", path: "src/a.js", diff: "@@\n" },
        status: "completed",
      },
      {
        type: "apply_patch_call_output",
        call_id: "call_patch",
        status: "completed",
        output: "Done",
      },
      {
        type: "shell_call",
        call_id: "call_shell",
        action: { commands: ["git diff"], timeout_ms: 1000 },
        status: "completed",
      },
      {
        type: "shell_call_output",
        call_id: "call_shell",
        output: [
          {
            stdout: "clean",
            stderr: "",
            outcome: { type: "exit", exit_code: 0 },
          },
        ],
        max_output_length: 1000,
        status: "completed",
      },
    ]);
  });

  it("preserves Responses text.format for structured outputs", () => {
    const executor = new CodexExecutor();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const body = {
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test for session title" }] }],
      stream: true,
      metadata: { unsupported: true },
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    };

    executor.transformRequest("gpt-5.4-mini", body, true, {
      connectionId: "test-codex-structured-output",
      providerSpecificData: {},
    });

    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "codex_output_schema",
        strict: true,
        schema,
      },
    });
    expect(body.metadata).toBeUndefined();
  });

  it("preserves Responses-native tool_search tools", () => {
    const tools = normalizeTools([
      {
        type: "tool_search",
        execution: "sync",
        description: "Discover deferred tools",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "namespace",
        name: "codex_app",
        description: "app tools",
        tools: [
          {
            type: "function",
            name: "automation_update",
            description: "automation",
            parameters: { type: "object", properties: {} },
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "plain_fn",
        description: "plain",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(tools.map((tool) => `${tool.type}:${tool.name || ""}`)).toEqual([
      "tool_search:",
      "namespace:codex_app",
      "function:plain_fn",
    ]);
    expect(tools[0].execution).toBe("client");
  });

  it("preserves hosted Responses tools", () => {
    const tools = normalizeTools([
      { type: "web_search", search_context_size: "medium" },
      { type: "image_generation", size: "1024x1024" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
      { type: "local_shell" },
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "computer", display_width: 1024, display_height: 768, environment: "browser" },
    ]);

    expect(tools.map((tool) => tool.type)).toEqual([
      "web_search",
      "image_generation",
      "mcp",
      "local_shell",
      "code_interpreter",
      "computer",
    ]);
  });

  it("preserves custom freeform tools with format payloads", () => {
    const tools = normalizeTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });
});
