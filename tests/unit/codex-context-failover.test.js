import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connections: [], fetch: vi.fn(), updates: vi.fn(), saved: vi.fn(async () => {}) }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, rtkEnabled: false, providerStrategies: {} }),
  getProviderConnections: async ({ provider, isActive } = {}) => structuredClone(mocks.connections.filter(c => (!provider || c.provider === provider) && (isActive === undefined || c.isActive === isActive))),
  updateProviderConnection: async (id, update) => { mocks.updates(id, update); Object.assign(mocks.connections.find(c => c.id === id), update); },
  validateApiKey: async () => true, getProxyPools: async () => [],
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: () => null }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async model => ({ provider: "codex", model: model.replace(/^cx\//, "") }),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => mocks.fetch(...args) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: mocks.saved, saveRequestUsage: vi.fn(async () => {}) }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { createRequestBudget } = await import("../../open-sse/utils/requestBudget.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const models = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"];
const history = () => [
  { type: "compaction", encrypted_content: "opaque-checkpoint" },
  { type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] },
  { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the previous requirements" }] },
  { type: "function_call", call_id: "call_1", name: "read", namespace: "files", arguments: "{}" },
  { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Keep PostgreSQL" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Continue using these requirements" }, { type: "input_file", filename: "spec.txt", file_data: "data:text/plain;base64,QQ==" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
];
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const success = () => sse(event("response.output_text.delta", { delta: "OK" }) + event("response.completed", { response: { status: "completed", output: [], usage: { input_tokens: 25, output_tokens: 1 } } }));
let sequence = 0;
function request(model, input = history(), extra = {}, session = `audit-${++sequence}`) {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-tui/0.144.1", "session_id": session }, body: JSON.stringify({ model, instructions: "Keep the project requirements", input, stream: true, ...extra }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = [
    { id: "relay", provider: "codex", authType: "apikey", apiKey: "mock-relay", name: "relay", priority: 1, isActive: true, providerSpecificData: { baseUrl: "https://relay.invalid/v1" } },
    { id: "oauth", provider: "codex", authType: "oauth", accessToken: "mock-oauth", name: "oauth", priority: 2, isActive: true, providerSpecificData: {} },
  ];
  mocks.fetch.mockImplementation(async () => success());
});

describe("Codex account fallback with complete Responses history", () => {
  it.each(models)("preserves %s context when relay quota fails and OAuth takes over", async model => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "Credit balance exhausted" } }), { status: 402 }));
    const response = await handleChat(request(model));
    expect(await response.text()).toContain("response.completed");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.fetch.mock.calls.map(([url, init]) => ({ url, headers: init.headers, body: JSON.parse(init.body) }));
    expect(first.url).toBe("https://relay.invalid/v1/responses");
    expect(second.url).toContain("/backend-api/codex/responses");
    expect(first.body.input).toEqual(second.body.input);
    expect(second.body.input[0]).toEqual(history()[0]);
    expect(second.body.input[2].phase).toBe("commentary");
    expect(second.body.input[3].namespace).toBe("files");
    expect(second.body.input[4].output).toEqual(history()[4].output);
    expect(second.body.input[5].content).toEqual(history()[5].content);
    expect(second.body.instructions).toBe(first.body.instructions);
    expect(second.body.prompt_cache_key).toBe(first.body.prompt_cache_key);
    expect(second.headers.Authorization).toBe("Bearer mock-oauth");
    expect(mocks.connections[0].modelLock___all).toBeTruthy();
  });

  it.each(["sse", "json"])("recognizes HTTP 200 %s quota errors and switches", async kind => {
    const error = { code: "usage_limit_reached", message: "Usage exhausted", resets_in_seconds: 5 * 60 * 60 };
    mocks.fetch.mockResolvedValueOnce(kind === "sse" ? sse(event("response.failed", { response: { status: "failed", error } })) : new Response(JSON.stringify({ error }), { headers: { "content-type": "application/json" } }));
    const response = await handleChat(request("gpt-6-astra"));
    expect(await response.text()).toContain("response.completed");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(new Date(mocks.connections[0]["modelLock_gpt-6-astra"]).getTime() - Date.now()).toBeGreaterThan(4.9 * 60 * 60 * 1000);
  });

  it("keeps the replacement account for the conversation after the first recovers", async () => {
    const session = `affinity-${++sequence}`;
    mocks.fetch.mockResolvedValueOnce(new Response("Credit balance exhausted", { status: 402 }));
    await (await handleChat(request("gpt-6-astra", history(), {}, session))).text();
    mocks.connections[0].modelLock___all = null;
    await (await handleChat(request("gpt-6-astra", history(), {}, session))).text();
    expect(mocks.fetch.mock.calls[2][0]).toContain("/backend-api/codex/responses");
    await (await handleChat(request("gpt-6-astra"))).text();
    expect(mocks.fetch.mock.calls[3][0]).toBe("https://relay.invalid/v1/responses");
  });

  it.each(["Invalid schema", "maximum context length exceeded", "invalid_encrypted_content"])("does not call every account for %s", async message => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message } }), { status: 400 }));
    expect((await handleChat(request("gpt-6-astra"))).status).toBe(400);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.updates).not.toHaveBeenCalled();
  });

  it("rejects server-only history before calling an account", async () => {
    const response = await handleChat(request("gpt-6-astra", "Continue", { previous_response_id: "resp_previous" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("complete input history");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns compact JSON with every output item unchanged", async () => {
    const compact = { object: "response.compaction", output: [history()[0], history()[5]], usage: { input_tokens: 20, output_tokens: 5 } };
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(compact), { headers: { "content-type": "application/json" } }));
    const response = await handleChat(request("gpt-6-astra", history(), { _compact: true, stream: false }));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(compact);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url.endsWith("/responses/compact")).toBe(true);
    expect(init.headers.Accept).toBe("application/json");
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(["input", "instructions", "model"]);
  });

  it("does not replay a stream after text or an async tool action starts", async () => {
    mocks.fetch.mockResolvedValueOnce(sse(event("response.output_item.added", { item: { type: "function_call", call_id: "async_1", name: "read", arguments: "{}" } }) + event("response.failed", { response: { error: { code: "insufficient_quota", message: "Credit balance exhausted" } } })));
    const response = await handleChat(request("gpt-6-astra"));
    const text = await response.text();
    expect(text).toContain("async_1"); expect(text).toContain("response.failed");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.connections[0].modelLock___all).toBeTruthy());
    expect(mocks.updates.mock.calls.some(([, update]) => update.testStatus === "active")).toBe(false);
  });

  it("aborts the whole chain before a new account is called", async () => {
    const controller = new AbortController();
    const base = request("gpt-6-astra");
    const req = new Request(base, { signal: controller.signal });
    mocks.fetch.mockImplementationOnce(async () => { controller.abort(); return new Response("Rate limit", { status: 429 }); });
    expect((await handleChat(req)).status).toBe(499);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps reset and Retry-After timers rather than retrying exhausted accounts early", async () => {
    const response = new Response("rate limit", { status: 429, headers: { "Retry-After": "7200" } });
    mocks.fetch.mockResolvedValueOnce(response);
    await (await handleChat(request("gpt-6-astra"))).text();
    expect(new Date(mocks.connections[0]["modelLock_gpt-6-astra"]).getTime() - Date.now()).toBeGreaterThan(7100000);
    const prior = mocks.updates.mock.calls.length;
    await markAccountUnavailable("relay", 499, "Request aborted", "codex", "gpt-6-astra");
    expect(mocks.updates).toHaveBeenCalledTimes(prior);
  });

  it("bounds the total upstream calls even with a large exhausted pool", async () => {
    const template = mocks.connections[0];
    mocks.connections = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(template), id: `pool-${i}`, priority: i + 1 }));
    mocks.fetch.mockImplementation(async () => new Response("Credit balance exhausted", { status: 402 }));
    const response = await handleChat(request("gpt-6-astra"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("routing_budget_exhausted");
    expect(mocks.fetch).toHaveBeenCalledTimes(8);
  });
});

it.each([true, false])("preserves a completed JSON response when relay ignores stream=%s", async stream => {
  const output = [history()[0], { type: "message", id: "msg_final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "PostgreSQL remains required", annotations: [] }] }, { type: "function_call", id: "fc_1", call_id: "call_2", name: "read", arguments: "{}", status: "completed" }];
  const value = { object: "response", id: "resp_json", status: "completed", model: "gpt-6-astra", output, usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 15 } } };
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
  const response = await handleChat(request("gpt-6-astra", history(), { stream }));
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  if (stream) {
    const text = await response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.function_call_arguments.delta");
    const terminal = text.split("\n").filter(line => line.startsWith("data:" )).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } }).find(item => item?.type === "response.completed");
    expect(terminal.response).toEqual(value);
  } else expect(await response.json()).toMatchObject({ output, usage: value.usage });
});

it.each(["none", "minimal", "max"])("keeps Astra settings and native tools with reasoning %s", async effort => {
  const update = { type: "configuration_update", reasoning: { effort: "high" } };
  await (await handleChat(request("gpt-6-astra", [...history(), update], {
    reasoning: { effort }, temperature: 0.2, top_p: 0.8, include: ["message.output_text.logprobs", "web_search_call.action.sources"],
    prompt_cache_options: { ttl: "30m" },
    tools: [{ type: "function", name: "read", parameters: {}, async: true }, { type: "custom", name: "patch", async: true }, { type: "shell", environment: { type: "local" } }, { type: "apply_patch" }],
  }))).text();
  const wire = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  expect(wire.reasoning.effort).toBe(effort === "max" ? "max" : "low");
  expect(wire.input.at(-1)).toEqual(update);
  expect(wire.prompt_cache_options).toEqual({ ttl: "30m" });
  expect(wire.tools).toHaveLength(4);
  expect(wire.tools.slice(0, 2).every(tool => tool.async)).toBe(true);
  expect(wire.include).toEqual(["web_search_call.action.sources", "reasoning.encrypted_content"]);
  expect(wire.temperature).toBeUndefined(); expect(wire.top_p).toBeUndefined();
});

it("rejects Astra tools on Chat Completions before sending any request", async () => {
  const result = await handleChatCore({ body: { model: "gpt-6-astra", messages: [{ role: "user", content: "Read the file" }], tools: [{ type: "function", function: { name: "read", parameters: {} } }] }, modelInfo: { provider: "openai-compatible-test", model: "gpt-6-astra" }, credentials: { providerSpecificData: { apiType: "chat-completions" } } });
  expect(result.status).toBe(400);
  expect(result.error).toContain("requires a Responses-compatible endpoint");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("requests encrypted reasoning even when only reasoning metadata is supplied", async () => {
  await (await handleChat(request("gpt-6-astra", history(), { reasoning: { summary: "detailed" } }))).text();
  const wire = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  expect(wire.include).toContain("reasoning.encrypted_content");
  expect(wire.reasoning.summary).toBe("detailed");
});

it("returns a failed HTML relay response as an error and falls back", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response("<html><title>Gateway unavailable</title></html>", { headers: { "content-type": "text/html" } }));
  const response = await handleChat(request("gpt-6-astra"));
  expect(await response.text()).toContain("response.completed");
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("limits transient retries without repeatedly transforming the same history", async () => {
  const executor = new BaseExecutor("test", { baseUrl: "https://test.invalid", retry: { 503: { attempts: 5, delayMs: 0 } } });
  const canonical = { input: history() };
  executor.transformRequest = (model, body) => { body.input[2].content.push({ type: "output_text", text: "one transformation" }); return body; };
  mocks.fetch.mockImplementation(async () => new Response("Temporarily unavailable", { status: 503 }));
  const result = await executor.execute({ model: "gpt-6-astra", body: canonical, credentials: {}, retryBudget: createRequestBudget() });
  expect(result.response.status).toBe(503);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.fetch.mock.calls[0][1].body).toBe(mocks.fetch.mock.calls[1][1].body);
  expect(canonical.input).toEqual(history());
});

it("leaves the caller payload unchanged across executor retries", async () => {
  const body = { model: "gpt-5.6-sol", input: history(), instructions: "Keep everything", reasoning: { effort: "high", context: "all_turns" }, tools: [{ type: "function", name: "read", parameters: {}, async: true, defer_loading: true, strict: false }] };
  const before = structuredClone(body);
  const executor = new CodexExecutor();
  await executor.execute({ model: body.model, body, stream: true, credentials: { accessToken: "mock", connectionId: "mock" } });
  expect(body).toEqual(before);
  const wire = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  expect(wire.tools[0]).toMatchObject({ async: true, defer_loading: true, strict: false });
  expect(wire.reasoning.context).toBe("all_turns");
});

it("fails clearly before converting opaque Responses state to Chat Completions", async () => {
  const result = await handleChatCore({ body: { model: "gpt-6-astra", input: history() }, modelInfo: { provider: "openai-compatible-test", model: "gpt-6-astra" }, credentials: { providerSpecificData: { apiType: "chat-completions" } }, sourceFormatOverride: "openai-responses" });
  expect(result.status).toBe(400);
  expect(result.error).toContain("continuity_not_supported");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
