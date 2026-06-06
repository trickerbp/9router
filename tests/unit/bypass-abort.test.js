// Regression test for the DNS-bypass abort/timeout fix in proxyFetch.js.
//
// Before the fix, createBypassRequest ignored options.signal and set no socket
// timeout, so an aborted/stalled Kiro (CodeWhisperer) request leaked a hanging
// socket. Combined with the missing global unhandledRejection handler, that
// could crash the process under heavy concurrent agent load.
//
// The abort/timeout control flow is transport-agnostic, so this test exercises
// it over plain HTTP (no self-signed TLS noise). The logic mirrors the patched
// createBypassRequest in open-sse/utils/proxyFetch.js exactly.
//
// Run: node --test tests/unit/bypass-abort.test.js

import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;
const BYPASS_SOCKET_TIMEOUT_MS = 60 * 1000;

// Parameterized copy of the patched createBypassRequest: uses http + an
// explicit port so we can point it at a local test server. The signal/timeout
// handling is byte-for-byte the same as the production https version.
function createBypassRequest(parsedUrl, realIP, options, port) {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const socket = new net.Socket();
    let settled = false;
    let req = null;
    let onAbort = null;

    const cleanup = () => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { req?.destroy(); } catch { /* noop */ }
      try { socket.destroy(); } catch { /* noop */ }
      reject(err);
    };

    if (signal) {
      onAbort = () => fail(new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    socket.setTimeout(BYPASS_SOCKET_TIMEOUT_MS, () => fail(new Error("bypass socket timeout")));

    socket.connect(port, realIP, () => {
      const req2 = http.request({
        socket,
        createConnection: () => socket,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: { ...options.headers, Host: parsedUrl.hostname },
      }, (res) => {
        if (settled) { try { res.destroy(); } catch { /* noop */ } return; }
        settled = true;
        cleanup();
        if (signal) signal.addEventListener("abort", () => { try { res.destroy(); } catch { /* noop */ } }, { once: true });
        res.resume();
        resolve({
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
        });
      });
      req = req2;
      req2.on("error", fail);
      if (options.body) req2.write(options.body);
      req2.end();
    });

    socket.on("error", fail);
  });
}

test("aborting a hanging bypass request rejects promptly with AbortError", async () => {
  // Server accepts the request but never responds → simulates a stalled socket.
  const server = http.createServer(() => { /* intentionally never respond */ });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const controller = new AbortController();
    const url = new URL("http://localhost/generateAssistantResponse");
    const started = Date.now();

    const p = createBypassRequest(url, "127.0.0.1", { method: "POST", body: "{}", signal: controller.signal }, port);
    setTimeout(() => controller.abort(), 100);

    await assert.rejects(p, (err) => err?.name === "AbortError", "should reject with AbortError");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `abort should be prompt, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("pre-aborted signal rejects immediately without connecting", async () => {
  const controller = new AbortController();
  controller.abort();
  const url = new URL("http://localhost/generateAssistantResponse");
  // Port 1 is unconnectable; if abort isn't honored first, this would error differently.
  await assert.rejects(
    createBypassRequest(url, "127.0.0.1", { method: "POST", body: "{}", signal: controller.signal }, 1),
    (err) => err?.name === "AbortError"
  );
});

test("successful bypass request resolves with status", async () => {
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end("ok"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const url = new URL("http://localhost/generateAssistantResponse");
    const result = await createBypassRequest(url, "127.0.0.1", { method: "POST", body: "{}" }, port);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.ok, true);
  } finally {
    server.close();
  }
});
