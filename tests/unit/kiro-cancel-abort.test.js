// Regression test for the Kiro "cancel task" fix in src/mitm/handlers/base.js.
//
// Before the fix, fetchRouter() called fetch() with no AbortSignal and the pipe
// loops kept reading from the upstream provider after the IDE dropped its
// connection. Clicking "Stop" in Kiro therefore kept burning the provider
// account's quota on a response nobody read.
//
// The fix:
//   - watchClientAbort(req, res) returns an AbortController that fires when the
//     client request aborts or the response socket closes mid-stream.
//   - fetchRouter forwards that signal to fetch().
//   - the pipe loops break (and stop writing) once the client is gone.
//
// Run: node --test tests/unit/kiro-cancel-abort.test.js

import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { watchClientAbort, pipeTransformedEventStream } = require("../../src/mitm/handlers/base.js");

// Minimal fake of http.IncomingMessage: just an EventEmitter.
function fakeReq() {
  return new EventEmitter();
}

// Minimal fake of http.ServerResponse that records writes and end state.
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.headersSent = false;
  res.written = [];
  res.writeHead = () => { res.headersSent = true; };
  res.write = (chunk) => { res.written.push(chunk); return true; };
  res.end = () => { res.writableEnded = true; res.writableFinished = true; res.emit("close"); };
  return res;
}

// Build a Response-like object whose body is a ReadableStream that emits SSE
// chunks on a timer, so we can interleave a client abort mid-stream.
function streamingRouterRes(chunks, gapMs) {
  let i = 0;
  let timer = null;
  const stream = new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunks[i++]));
      }, gapMs);
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return { status: 200, headers: new Map(), body: stream };
}

test("watchClientAbort fires when the client request aborts", () => {
  const req = fakeReq();
  const res = fakeRes();
  const { controller, cleanup } = watchClientAbort(req, res);

  assert.strictEqual(controller.signal.aborted, false);
  req.emit("aborted");
  assert.strictEqual(controller.signal.aborted, true, "signal should abort on req 'aborted'");
  cleanup();
});

test("watchClientAbort fires when the response socket closes mid-stream", () => {
  const req = fakeReq();
  const res = fakeRes();
  const { controller, cleanup } = watchClientAbort(req, res);

  // Socket closed but response never finished writing → treated as cancel.
  res.writableFinished = false;
  res.emit("close");
  assert.strictEqual(controller.signal.aborted, true, "signal should abort on premature close");
  cleanup();
});

test("watchClientAbort does NOT fire on a normal completed response", () => {
  const req = fakeReq();
  const res = fakeRes();
  const { controller, cleanup } = watchClientAbort(req, res);

  res.end(); // normal completion sets writableFinished=true then emits close
  assert.strictEqual(controller.signal.aborted, false, "normal end must not look like a cancel");
  cleanup();
});

test("pipeTransformedEventStream stops writing after the client disconnects", async () => {
  // 5 content chunks, 20ms apart. We abort the client after ~50ms (~2 chunks).
  const chunks = Array.from({ length: 5 }, (_, n) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: `tok${n}` } }] })}\n\n`
  );
  const routerRes = streamingRouterRes(chunks, 20);
  const res = fakeRes();

  // transformFn just passes the content text through as a Buffer.
  const transformFn = (parsed) => {
    if (!parsed) return null;
    const text = parsed.choices?.[0]?.delta?.content;
    return text ? Buffer.from(text) : null;
  };

  // Simulate the client hanging up partway through.
  setTimeout(() => { res.destroyed = true; res.emit("close"); }, 50);

  await pipeTransformedEventStream(routerRes, res, transformFn, {});

  // It must have stopped early — far fewer than all 5 tokens written.
  assert.ok(res.written.length < 5, `expected early stop, wrote ${res.written.length}/5 chunks`);
});

test("pipeTransformedEventStream writes all chunks when client stays connected", async () => {
  const chunks = Array.from({ length: 3 }, (_, n) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: `tok${n}` } }] })}\n\n`
  );
  const routerRes = streamingRouterRes(chunks, 5);
  const res = fakeRes();
  const transformFn = (parsed) => {
    if (!parsed) return null;
    const text = parsed.choices?.[0]?.delta?.content;
    return text ? Buffer.from(text) : null;
  };

  await pipeTransformedEventStream(routerRes, res, transformFn, {});

  assert.strictEqual(res.written.length, 3, "all 3 tokens should be written on clean run");
  assert.strictEqual(res.writableEnded, true, "response should be ended");
});
