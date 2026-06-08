/**
 * Unit tests for open-sse/translator/request/openai-to-kiro.js
 *
 * Tests cover:
 *  - buildKiroPayload() - basic message conversion
 *  - Image forwarding fix: images in currentMessage must be included in payload
 */

import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";

describe("buildKiroPayload", () => {
  describe("basic message conversion", () => {
    it("should convert a simple text message", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("Hello");
      expect(currentMsg.userInputMessage.modelId).toBe("claude-sonnet-4.6");
      expect(currentMsg.userInputMessage.origin).toBe("AI_EDITOR");
    });

    it("should not include images field when no images are present", () => {
      const body = {
        messages: [{ role: "user", content: "No images here" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });
  });

  describe("image forwarding", () => {
    it("should forward base64 image from image_url content part", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeDefined();
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
      expect(currentMsg.userInputMessage.images[0].format).toBe("png");
      expect(currentMsg.userInputMessage.images[0].source.bytes).toBe(fakeBase64);
    });

    it("should forward multiple base64 images", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these images" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toHaveLength(2);
      expect(currentMsg.userInputMessage.images[0].format).toBe("jpeg");
      expect(currentMsg.userInputMessage.images[1].format).toBe("png");
    });

    it("should not include images field when images array is empty", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Just text" }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });

    it("should include both images and text content together", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("What is in this image?");
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
    });

    it("should treat http image URLs as text fallback (Kiro only supports base64)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this" },
              { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      // HTTP URLs are not supported by Kiro — converted to text placeholder
      expect(currentMsg.userInputMessage.images).toBeUndefined();
      expect(currentMsg.userInputMessage.content).toContain("[Image: https://example.com/photo.jpg]");
    });
  });

  describe("tool interaction without client-provided tools", () => {
    // When the client omits `tools` (e.g. after compaction), structured tool
    // content must be flattened to text so Kiro's "tools required" 400 never
    // fires and no phantom tool-calling capability is advertised.

    it("should flatten OpenAI tool_calls + tool result into history text with no tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file contents here" },
          { role: "user", content: "Summarize it" }
        ]
        // note: no `tools`
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      // No structured tool content anywhere
      expect(cs.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined();
      const allJson = JSON.stringify(cs);
      expect(allJson).not.toContain("toolUses");
      expect(allJson).not.toContain("toolResults");

      // Tool call + result preserved as readable text (call lands in history,
      // result merges into the final currentMessage — assert across both)
      expect(allJson).toContain("[Tool call: read_file(");
      expect(allJson).toContain("[Tool result: file contents here]");
    });

    it("should flatten Claude tool_use / tool_result blocks with no tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Do it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling tool" },
              { type: "tool_use", id: "tu_1", name: "search", input: { q: "kiro" } }
            ]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "result text" }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      const allJson = JSON.stringify(cs);
      expect(allJson).not.toContain("toolUses");
      expect(allJson).not.toContain("toolResults");
      expect(allJson).toContain("[Tool call: search(");
      expect(allJson).toContain("[Tool result: result text]");
    });

    it("should keep structured tools when the client DOES provide a tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file contents here" },
          { role: "user", content: "Summarize it" }
        ],
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      // Structured tool spec carried on currentMessage
      const tools = cs.currentMessage.userInputMessage.userInputMessageContext?.tools;
      expect(tools).toBeDefined();
      expect(tools[0].toolSpecification.name).toBe("read_file");

      // Structured tool history preserved (not flattened to text)
      const allJson = JSON.stringify(cs);
      expect(allJson).toContain("toolUses");
      expect(allJson).not.toContain("[Tool call:");
    });

    it("should salvage orphaned tool_result content as text instead of discarding it", () => {      // Client provides tools, but compaction removed the assistant tool_use
      // message, leaving a tool_result whose tool_use_id matches nothing.
      const body = {
        messages: [
          { role: "user", content: "Start" },
          // (assistant tool_use for "orphan_call" was compacted away)
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "orphan_call", content: "important orphaned output" }
            ]
          },
          { role: "user", content: "Now continue" }
        ],
        tools: [
          {
            type: "function",
            function: { name: "some_tool", description: "x", parameters: { type: "object", properties: {}, required: [] } }
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;
      const allJson = JSON.stringify(cs);

      // The dangling structured reference is gone (would trigger Kiro 400)...
      expect(allJson).not.toContain("orphan_call");
      // ...but the content is preserved as salvaged text, not discarded.
      expect(allJson).toContain("[Tool result: important orphaned output]");
    });
  });

  describe("payload budget (CONTENT_LENGTH_EXCEEDS_THRESHOLD guard)", () => {
    // Kiro upstream 400s when the serialized conversationState exceeds its input
    // threshold. buildKiroPayload must proactively trim to stay under
    // KIRO_MAX_PAYLOAD_BYTES (default 500KB) instead of letting it fail.
    const LIMIT = 500_000;

    it("should drop oldest history turns to fit an oversized conversation", () => {
      // Build a long conversation that overflows the limit. Each turn ~20KB.
      const big = "x".repeat(20_000);
      const messages = [];
      for (let i = 0; i < 40; i++) {
        messages.push({ role: "user", content: `turn ${i} ${big}` });
        messages.push({ role: "assistant", content: `reply ${i} ${big}` });
      }
      messages.push({ role: "user", content: "FINAL QUESTION" });

      const result = buildKiroPayload("claude-sonnet-4.6", { messages }, true, {});
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");

      expect(bytes).toBeLessThanOrEqual(LIMIT);
      // The most recent turn (current message) is always preserved.
      expect(result.conversationState.currentMessage.userInputMessage.content)
        .toContain("FINAL QUESTION");
      // Some history was shed.
      expect(result.conversationState.history.length).toBeLessThan(80);
    });

    it("should not trim a conversation already within budget", () => {
      const body = { messages: [{ role: "user", content: "short" }] };
      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      // History stays empty (single turn), content intact, no truncation marker.
      expect(result.conversationState.history).toHaveLength(0);
      expect(result.conversationState.currentMessage.userInputMessage.content)
        .toContain("short");
      expect(JSON.stringify(result)).not.toContain("truncated to fit");
    });

    it("should truncate the current message as a last resort when it alone overflows", () => {
      // A single user turn larger than the entire budget — nothing to drop.
      const huge = "y".repeat(LIMIT + 100_000);
      const body = { messages: [{ role: "user", content: huge }] };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");

      expect(bytes).toBeLessThanOrEqual(LIMIT);
      expect(result.conversationState.currentMessage.userInputMessage.content)
        .toContain("truncated to fit Kiro input limit");
    });

    it("should not dangle a toolResult when dropping the assistant turn that produced it", () => {
      // tools present → structured path. Old turns carry tool_use/tool_result
      // pairs; trimming the assistant tool_use turn must re-fold its orphaned
      // result to text rather than leave a dangling reference (itself a 400).
      const big = "z".repeat(30_000);
      const messages = [];
      for (let i = 0; i < 30; i++) {
        messages.push({ role: "user", content: `q${i} ${big}` });
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "rd", arguments: "{}" } }]
        });
        messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `res${i} ${big}` });
      }
      messages.push({ role: "user", content: "LAST" });

      const tools = [{
        type: "function",
        function: { name: "rd", description: "read", parameters: { type: "object", properties: {}, required: [] } }
      }];

      const result = buildKiroPayload("claude-sonnet-4.6", { messages, tools }, true, {});
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      const cs = result.conversationState;

      expect(bytes).toBeLessThanOrEqual(LIMIT);

      // Every surviving toolResult must have a matching toolUse somewhere in history.
      const validIds = new Set();
      for (const h of cs.history) {
        for (const tu of h.assistantResponseMessage?.toolUses || []) {
          if (tu.toolUseId) validIds.add(tu.toolUseId);
        }
      }
      const carriers = [...cs.history, cs.currentMessage];
      for (const item of carriers) {
        const trs = item.userInputMessage?.userInputMessageContext?.toolResults || [];
        for (const tr of trs) {
          expect(validIds.has(tr.toolUseId)).toBe(true);
        }
      }
    });
  });
});
