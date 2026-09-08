import { RESPONSES_ROUTING } from "../config/responsesRouting.js";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getErrorEnvelope, parseProviderError } from "./upstreamError.js";

export async function peekResponsesError(response, signal = null) {
  const none = { matched: null, message: null, accountFallback: false, replacementBody: null };
  if (!response?.ok || !response.body) return none;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const value = await response.clone().json().catch(() => null);
    if (!getErrorEnvelope(value)) return none;
    const error = parseProviderError(200, value, response.headers);
    return { ...error, matched: error.code || error.category, accountFallback: true };
  }
  if (contentType && !contentType.includes("text/event-stream")) return none;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let buffer = "", event = "", bytes = 0, error = null, committed = false;
  const timeout = AbortSignal.timeout(STREAM_FIRST_CHUNK_TIMEOUT_MS);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cancel = () => { reader.cancel(readSignal.reason).catch(() => {}); };
  readSignal.addEventListener("abort", cancel, { once: true });
  const inspect = (line) => {
    if (line.startsWith("event:")) { event = line.slice(6).trim(); return; }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { committed = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { return; }
    const type = value.type || event;
    const envelope = getErrorEnvelope(value);
    if (envelope) { error = parseProviderError(200, { error: envelope }, response.headers); return; }
    // Stop before any visible output or tool action is handed to the client.
    if (/^response\.(output_text|function_call_arguments|custom_tool_call_input)\./.test(type) ||
        /^response\.(completed|done|incomplete)$/.test(type) ||
        /^response\.output_item\./.test(type) && value.item?.type !== "reasoning") committed = true;
  };
  try {
    while (bytes < RESPONSES_ROUTING.peekBytes && !error && !committed) {
      readSignal.throwIfAborted();
      const { done, value } = await reader.read();
      readSignal.throwIfAborted();
      if (done) { if (buffer) inspect(buffer.trim()); break; }
      chunks.push(value); bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) { inspect(line); if (error || committed) break; }
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    readSignal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (error) {
    await response.body.cancel().catch(() => {});
    return { ...error, matched: error.code || error.category, accountFallback: true };
  }
  let upstream;
  const replacementBody = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); upstream = response.body.getReader(); },
    async pull(controller) {
      try { const { done, value } = await upstream.read(); if (done) controller.close(); else controller.enqueue(value); }
      catch (e) { controller.error(e); }
    },
    cancel(reason) { return upstream.cancel(reason); },
  });
  return { ...none, replacementBody };
}
