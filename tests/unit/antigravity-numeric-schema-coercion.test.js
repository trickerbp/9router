import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.js";
import { coerceNumericSchemaKeywords } from "../../open-sse/translator/concerns/schemaCoercion.js";

const SEND_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    Message: { type: "string", description: "Content of the message.", minLength: "1" },
    Recipient: { type: "string", description: "Conversation ID.", minLength: "1" },
  },
  required: ["Recipient", "Message"],
};

function sendMessageTool(schema) {
  return { type: "function", name: "send_message", description: "Send a message.", parameters: schema };
}

describe("numeric JSON Schema keyword coercion", () => {
  it("coerces string-typed numeric keywords recursively", () => {
    const schema = {
      type: "object",
      properties: {
        list: { type: "array", minItems: "0", items: { type: "string", maxLength: "64" } },
      },
      minimum: "1",
      maximum: "10",
      description: "2",
    };

    coerceNumericSchemaKeywords(schema);

    expect(schema.properties.list.minItems).toBe(0);
    expect(schema.properties.list.items.maxLength).toBe(64);
    expect(schema.minimum).toBe(1);
    expect(schema.maximum).toBe(10);
    // Non-keyword strings are left untouched.
    expect(schema.description).toBe("2");
  });

  it("coerces Antigravity functionDeclarations schemas during translation", () => {
    const translated = antigravityToOpenAIRequest(
      "gpt-6-astra",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [
            {
              functionDeclarations: [
                { name: "send_message", description: "Send a message.", parameters: SEND_MESSAGE_SCHEMA },
              ],
            },
          ],
        },
      },
      true
    );

    const parameters = translated.tools[0].function.parameters;
    expect(parameters.properties.Message.minLength).toBe(1);
    expect(parameters.properties.Recipient.minLength).toBe(1);
  });

  it("coerces additional_tools input items for responsesLite models", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-6.1-sol",
      instructions: "test",
      input: [
        { type: "additional_tools", role: "developer", tools: [sendMessageTool(SEND_MESSAGE_SCHEMA)] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      stream: true,
    };

    executor.transformRequest("gpt-6.1-sol", body, true, {
      connectionId: "test-numeric-schema-additional-tools",
      providerSpecificData: {},
    });

    const item = body.input.find((entry) => entry.type === "additional_tools");
    const parameters = item.tools[0].parameters;
    expect(parameters.properties.Message.minLength).toBe(1);
    expect(parameters.properties.Recipient.minLength).toBe(1);
  });

  it("coerces top-level tools schemas", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.5",
      instructions: "test",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [sendMessageTool(SEND_MESSAGE_SCHEMA)],
      stream: true,
    };

    executor.transformRequest("gpt-5.5", body, true, {
      connectionId: "test-numeric-schema-tools",
      providerSpecificData: {},
    });

    expect(body.tools[0].parameters.properties.Message.minLength).toBe(1);
  });
});
