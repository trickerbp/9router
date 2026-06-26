const { log, err } = require("../logger");

const DEFAULT_LOCAL_ROUTER = "http://localhost:8080";
const ROUTER_BASE = String(process.env.MITM_ROUTER_BASE || DEFAULT_LOCAL_ROUTER)
  .trim()
  .replace(/\/+$/, "") || DEFAULT_LOCAL_ROUTER;
const API_KEY = process.env.ROUTER_API_KEY;

// Headers that must not be forwarded to 9Router
const STRIP_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding",
  "content-type", "authorization"
]);

/**
 * Send body to 9Router at the given path and return the fetch Response object.
 * Optionally forwards client headers (stripped of hop-by-hop / overridden keys).
 */
async function fetchRouter(openaiBody, path = "/v1/chat/completions", clientHeaders = {}, signal) {
  const forwarded = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) forwarded[k] = v;
  }

  const response = await fetch(`${ROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      ...forwarded,
      "Content-Type": "application/json",
      ...(API_KEY && { "Authorization": `Bearer ${API_KEY}` })
    },
    body: JSON.stringify(openaiBody),
    // When the IDE cancels a task it drops the connection; this signal lets us
    // abort the upstream provider request instead of generating tokens nobody reads.
    ...(signal && { signal })
  });

  // Forward response as-is (status + body). pipeSSE will propagate status.
  return response;
}

/**
 * Watch the client (IDE) connection for an early disconnect and return an
 * AbortController that fires when it happens.
 *
 * Kiro/Copilot/Antigravity "Stop" buttons abort the HTTP request to this MITM
 * server. Without this, fetchRouter's upstream request keeps streaming from the
 * real provider account — burning quota on a response the IDE already discarded.
 *
 * The returned controller's signal should be passed to fetchRouter; call the
 * returned cleanup() once the stream finishes normally to detach listeners.
 */
function watchClientAbort(req, res) {
  const controller = new AbortController();
  const onClientGone = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  // `aborted` fires when the client resets the stream; `close` covers socket drop.
  req.on("aborted", onClientGone);
  res.on("close", () => {
    // res "close" also fires on normal end — only treat it as cancel if the
    // response did not finish writing (i.e. client hung up mid-stream).
    if (!res.writableFinished) onClientGone();
  });
  const cleanup = () => {
    req.off("aborted", onClientGone);
  };
  return { controller, cleanup };
}

/**
 * Pipe SSE stream from router directly to client response.
 * Optional dumper tees the stream into a debug file.
 */
async function pipeSSE(routerRes, res, dumper) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const status = routerRes.status || 200;
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(status, resHeaders);
  if (dumper) dumper.writeHeader(routerRes.status, Object.fromEntries(routerRes.headers));

  if (!routerRes.body) {
    const text = await routerRes.text().catch(() => "");
    if (dumper) { dumper.writeChunk(text); dumper.end(); }
    res.end(text);
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (res.writableEnded || res.destroyed) { await reader.cancel().catch(() => {}); break; }
      const { done, value } = await reader.read();
      if (done) { if (dumper) dumper.end(); if (!res.writableEnded) res.end(); break; }
      if (dumper) dumper.writeChunk(value);
      if (!res.writableEnded) res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // AbortError (client cancelled) or socket error — stop quietly; the upstream
    // fetch has already been signalled to abort by the handler's watchClientAbort.
    if (dumper) { try { dumper.end(); } catch {} }
    if (!res.writableEnded) { try { res.end(); } catch {} }
  }
}

/**
 * Pipe SSE stream from router, transforming each chunk through a user function.
 * Reads SSE data: lines, parses JSON, calls transformFn(parsed, state),
 * and writes returned SSE strings to the client response.
 *
 * @param {Response} routerRes - Fetch Response from 9Router
 * @param {http.ServerResponse} res - Client response
 * @param {Function} transformFn - (parsedChunk, state) => string|string[]|null
 * @param {object} state - Mutable state object shared across chunks and flush
 */
async function pipeTransformedSSE(routerRes, res, transformFn, state) {
  const ct = routerRes.headers.get("content-type") || "application/json";
  const resHeaders = { "Content-Type": ct, "Cache-Control": "no-cache", "Connection": "keep-alive" };
  if (ct.includes("text/event-stream")) resHeaders["X-Accel-Buffering"] = "no";
  res.writeHead(200, resHeaders);

  if (!routerRes.body) {
    res.end(await routerRes.text().catch(() => ""));
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let aborted = false;

  try {
    while (true) {
      if (res.writableEnded || res.destroyed) { aborted = true; await reader.cancel().catch(() => {}); break; }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        if (process.env.DEBUG_MITM) {
          log(`[SSE in] ${data.slice(0, 200)}`);
        }

        try {
          const parsed = JSON.parse(data);
          const result = transformFn(parsed, state);
          if (result != null) {
            const outputs = Array.isArray(result) ? result : [result];
            for (const output of outputs) {
              if (process.env.DEBUG_MITM) {
                const len = output.length || output.byteLength || 0;
                log(`[write binary frame] (${len}B) first 20B: ${Array.from(output.slice(0, 20)).join(',')}`);
              }
              if (!res.writableEnded) res.write(Buffer.from(output));
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch {
    // Client cancelled (AbortError) or socket error — stop reading upstream.
    aborted = true;
  }

  // Flush: pass null to signal stream end (skip if client already gone)
  if (!aborted && !res.writableEnded) {
    try {
      const flushed = transformFn(null, state);
      if (flushed != null) {
        const outputs = Array.isArray(flushed) ? flushed : [flushed];
        for (const output of outputs) {
          if (!res.writableEnded) res.write(output);
        }
      }
    } catch { /* ignore flush errors */ }
  }

  if (!res.writableEnded) { try { res.end(); } catch {} }
}

/**
 * Pipe SSE stream from router, transforming each chunk through a user function,
 * and writing binary EventStream frames to the client.
 *
 * Reads SSE data: lines, parses JSON, calls transformFn(parsed, state),
 * and writes returned Uint8Array frames to the client response.
 *
 * @param {Response} routerRes - Fetch Response from 9Router
 * @param {http.ServerResponse} res - Client response
 * @param {Function} transformFn - (parsedChunk, state) => Uint8Array|Uint8Array[]|null
 * @param {object} state - Mutable state object shared across chunks and flush
 */
async function pipeTransformedEventStream(routerRes, res, transformFn, state) {
  const resHeaders = {
    "Content-Type": "application/vnd.amazon.eventstream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  };
  res.writeHead(200, resHeaders);

  if (!routerRes.body) {
    res.end(await routerRes.text().catch(() => ""));
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let aborted = false;

  try {
    while (true) {
      if (res.writableEnded || res.destroyed) { aborted = true; await reader.cancel().catch(() => {}); break; }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        if (process.env.DEBUG_MITM) {
          log(`[SSE in] ${data.slice(0, 200)}`);
        }

        try {
          const parsed = JSON.parse(data);
          const result = transformFn(parsed, state);
          if (result != null) {
            const outputs = Array.isArray(result) ? result : [result];
            for (const output of outputs) {
              if (process.env.DEBUG_MITM) {
                const len = output.length || output.byteLength || 0;
                log(`[write binary frame] (${len}B) first 20B: ${Array.from(output.slice(0, 20)).join(',')}`);
              }
              if (!res.writableEnded) res.write(Buffer.from(output));
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch {
    // Client cancelled (AbortError) or socket error — stop reading upstream.
    aborted = true;
  }

  // Flush: pass null to signal stream end (skip if client already gone)
  if (!aborted && !res.writableEnded) {
    try {
      const flushed = transformFn(null, state);
      if (flushed != null) {
        const outputs = Array.isArray(flushed) ? flushed : [flushed];
        for (const output of outputs) {
          if (!res.writableEnded) res.write(output);
        }
      }
    } catch { /* ignore flush errors */ }
  }

  if (!res.writableEnded) { try { res.end(); } catch {} }
}

module.exports = { fetchRouter, watchClientAbort, pipeSSE, pipeTransformedSSE, pipeTransformedEventStream };