import { describe, expect, it, vi } from "vitest";
import { parseProviderError, providerErrorResponse } from "../../open-sse/utils/upstreamError.js";
import { peekResponsesError } from "../../open-sse/utils/responsesErrors.js";
import { observeResponsesStream } from "../../open-sse/utils/responsesObserver.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { checkFallbackError, isModelLockActive } from "../../open-sse/services/accountFallback.js";
import { createRequestBudget, checkRequestBudget, abortableDelay } from "../../open-sse/utils/requestBudget.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;

it.each([
  [{ error: { code: "insufficient_quota", message: "no credits" } }, "quota", "account"],
  [{ response: { error: { code: "usage_limit_reached", message: "limited" } } }, "quota", "model"],
  [{ code: 402, msg: "Payment required" }, "quota", "account"],
  [{ success: false, code: "insufficient_quota", msg: "Out" }, "quota", "account"],
  [{ data: { error: { code: "invalid_api_key", message: "invalid" } } }, "auth", "account"],
  [{ error: { code: "context_length_exceeded", message: "Too long" } }, "context", "model"],
])("recognizes structured relay failures: %j", async (body, category, scope) => {
  const peek = await peekResponsesError(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  expect(peek).toMatchObject({ category, scope });
  const normalized = providerErrorResponse(peek);
  expect(parseProviderError(normalized.status, await normalized.text())).toMatchObject({ category, scope });
});

it("honors reset timestamps and HTTP-date Retry-After", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  const reset = now + 5 * 3600000;
  expect(parseProviderError(429, { error: { resets_at: reset / 1000 } }, null, now).resetsAtMs).toBe(reset);
  expect(parseProviderError(429, {}, new Headers({ "Retry-After": new Date(reset).toUTCString() }), now).resetsAtMs).toBe(reset);
});

it("does not classify quota words in assistant output as an error", async () => {
  const text = frame({ type: "response.output_text.delta", delta: "The API returned insufficient_quota; check your credit balance." }) + frame({ type: "response.completed", response: { status: "completed", output: [] } });
  const peek = await peekResponsesError(sse(text));
  expect(peek.matched).toBeNull();
  expect(await new Response(peek.replacementBody).text()).toBe(text);
});

it("recognizes a quota frame split across arbitrary byte boundaries", async () => {
  const bytes = new TextEncoder().encode(frame({ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "Limited", resets_in_seconds: 100 } } }));
  let offset = 0;
  const body = new ReadableStream({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } } });
  expect(await peekResponsesError(new Response(body, { headers: { "content-type": "text/event-stream" } }))).toMatchObject({ category: "quota" });
});

it("cancels a waiting upstream reader when the request is aborted", async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } });
  const pending = peekResponsesError(response, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([400, 413, 422, 499])("does not cycle the account pool for request error %s", status => {
  expect(checkFallbackError(status, "Invalid input").shouldFallback).toBe(false);
});

it("does not let an expired model lock hide active account billing lock", () => {
  expect(isModelLockActive({ modelLock_gpt: new Date(Date.now() - 1000).toISOString(), modelLock___all: new Date(Date.now() + 10000).toISOString() }, "gpt")).toBe(true);
});

it("preserves all completed output and cached usage with data-only CRLF events", async () => {
  const output = [{ type: "compaction", encrypted_content: "opaque" }, { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] }];
  const usage = { input_tokens: 200, input_tokens_details: { cached_tokens: 190 }, output_tokens: 7 };
  const value = await convertResponsesStreamToJson(sse(frame({ type: "response.completed", response: { id: "resp_1", model: "gpt-6-astra", status: "completed", output, usage } })).body);
  expect(value).toMatchObject({ id: "resp_1", status: "completed", output, usage });
});

it.each([
  { type: "response.incomplete", response: { status: "incomplete" } },
  { type: "response.done", response: { status: "failed", error: { message: "Failed" } } },
])("does not mark failed terminal response as successful: %j", async value => {
  const onSuccess = vi.fn(), onFailure = vi.fn();
  const observed = observeResponsesStream(sse(frame(value)), onSuccess, onFailure);
  await observed.response.text();
  expect(observed.state.status).toBe("failed");
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect((await convertResponsesStreamToJson(sse(frame(value)).body)).status).toBe("failed");
});

it("bounds calls and aborts retry delays immediately", async () => {
  const budget = createRequestBudget(null, 1);
  checkRequestBudget(budget, true);
  expect(() => checkRequestBudget(budget, true)).toThrow("routing_budget_exhausted");
  const controller = new AbortController();
  const waiting = abortableDelay(60000, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});

it("reports a routing deadline as a timeout instead of client cancellation", () => {
  const controller = new AbortController();
  const budget = createRequestBudget(controller.signal);
  controller.abort(new DOMException("deadline", "TimeoutError"));
  expect(() => checkRequestBudget(budget)).toThrow("routing_deadline_exceeded");
  try { checkRequestBudget(budget); } catch (error) { expect(error.status).toBe(504); }
});

it("records transport failure after output starts without reporting success", async () => {
  const onSuccess = vi.fn(), onFailure = vi.fn(), onTransportEnd = vi.fn();
  let controller;
  const source = new ReadableStream({ start(value) { controller = value; } });
  const observed = observeResponsesStream(new Response(source), onSuccess, onFailure, onTransportEnd);
  const reader = observed.response.body.getReader();
  controller.enqueue(new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: "Partial" })));
  await reader.read();
  controller.error(new Error("socket hang up"));
  await expect(reader.read()).rejects.toThrow("socket hang up");
  expect(onSuccess).not.toHaveBeenCalled();
  expect(observed.state.status).toBe("failed");
  expect(onTransportEnd).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
});

it("does not lock an account when the client cancels after partial output", async () => {
  const onFailure = vi.fn();
  const observed = observeResponsesStream(new Response(new ReadableStream()), null, onFailure);
  await observed.response.body.cancel();
  expect(observed.state.status).toBe("cancelled");
  await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  const error = onFailure.mock.calls[0][0];
  expect(checkFallbackError(200, { error }).shouldFallback).toBe(false);
});

it.each(["codex", "openai", "openai-compatible-test"])("offers documented Astra reasoning levels for %s", provider => {
  expect(getThinkingLevels(provider, "gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max"]);
});
