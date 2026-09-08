// Observe terminal status without altering bytes, including when a client closes
// immediately after the terminal event instead of waiting for EOF.
export function observeResponsesStream(response, onSuccess, onFailure, onTransportEnd) {
  let pending = "", event = "", settled = false;
  const state = { status: "in_progress", error: null };
  const decoder = new TextDecoder();
  const settle = (status, error = null) => {
    if (settled) return;
    settled = true; state.status = status; state.error = error;
    const callback = status === "completed" ? onSuccess : onFailure;
    Promise.resolve().then(() => callback?.(error)).catch(() => {});
  };
  const inspect = (line) => {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (!line.startsWith("data:")) return;
    let data;
    try { data = JSON.parse(line.slice(5).trim()); } catch { return; }
    const type = data.type || event;
    if (["response.failed", "response.incomplete", "error"].includes(type) || data.error || data.response?.error || ["failed", "incomplete"].includes(data.response?.status)) {
      settle("failed", data.response?.error || data.error || { message: "Upstream response incomplete" });
    }
    else if (type === "response.completed" || type === "response.done") settle("completed");
  };
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode(); if (pending) inspect(pending);
          if (!settled) settle("failed", { code: "stream_disconnected", message: "Stream ended before a completed response" });
          controller.close();
          return;
        }
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
        for (const line of lines) inspect(line);
        controller.enqueue(value);
      } catch (error) {
        if (!settled) {
          settle("failed", { code: "stream_disconnected", message: error?.message || "Upstream stream disconnected" });
          onTransportEnd?.(state);
        }
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!settled) {
        settle("cancelled", { code: "client_disconnected", message: "Request aborted" });
        onTransportEnd?.(state);
      }
      return reader.cancel(reason);
    },
  });
  return { state, response: new Response(stream, { status: response.status, headers: response.headers }) };
}
