import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

function sseResponse() {
  return new Response([
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    "",
  ].join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function requestBody(extra = {}) {
  return {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: "check" }],
    stream: true,
    ...extra,
  };
}

describe("CodexExecutor request context", () => {
  let fetchMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockImplementation(async () => sseResponse());
  });

  it("keeps compact routing request-local on a shared executor", async () => {
    const executor = new CodexExecutor();
    const credentials = { accessToken: "token", connectionId: "conn" };

    await executor.execute({
      model: "gpt-5.6-sol",
      body: requestBody({ _compact: true }),
      stream: true,
      credentials,
    });
    await executor.execute({
      model: "gpt-5.6-sol",
      body: requestBody(),
      stream: true,
      credentials,
    });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/responses\/compact$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/responses$/);
  });

  it("preserves compact routing and session headers across repeated execution", async () => {
    const executor = new CodexExecutor();
    const body = requestBody({ _compact: true });
    const credentials = {
      accessToken: "token",
      connectionId: "conn",
      rawHeaders: { "x-session-id": "thread-56" },
    };

    await executor.execute({ model: "gpt-5.6-sol", body, stream: true, credentials });
    await executor.execute({ model: "gpt-5.6-sol", body, stream: true, credentials });

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toMatch(/\/responses\/compact$/);
      expect(init.headers.session_id).toBe("thread-56");
    }
    expect(body._compact).toBe(true);
  });

  it("does not cross-wire concurrent title and chat requests", async () => {
    const executor = new CodexExecutor();

    await Promise.all([
      executor.execute({
        model: "gpt-5.4-mini",
        body: requestBody({ model: "gpt-5.4-mini" }),
        stream: true,
        credentials: {
          accessToken: "token",
          connectionId: "conn-title",
          rawHeaders: { "x-session-id": "thread-title" },
        },
      }),
      executor.execute({
        model: "gpt-5.6-sol",
        body: requestBody({ _compact: true }),
        stream: true,
        credentials: {
          accessToken: "token",
          connectionId: "conn-chat",
          rawHeaders: { "x-session-id": "thread-chat" },
        },
      }),
    ]);

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    }));
    const title = requests.find((request) => request.body.model === "gpt-5.4-mini");
    const chat = requests.find((request) => request.body.model === "gpt-5.6-sol");

    expect(title.url).toMatch(/\/responses$/);
    expect(title.headers.session_id).toBe("thread-title");
    expect(chat.url).toMatch(/\/responses\/compact$/);
    expect(chat.headers.session_id).toBe("thread-chat");
  });
});
