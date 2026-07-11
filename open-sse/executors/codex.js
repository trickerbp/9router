import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { DEFAULT_RETRY_CONFIG, HTTP_STATUS, resolveRetryEntry } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { RESPONSES_ITEM } from "../translator/schema/index.js";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const CODEX_SSE_RETRY_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const CODEX_SSE_USER_OUTPUT_PATTERNS = [
  "event: response.output_text.delta",
  "event: response.function_call_arguments.delta",
  "event: response.custom_tool_call_input.delta",
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
  '"type":"response.custom_tool_call_input.delta"',
];
const CODEX_SSE_PEEK_BYTES = 256 * 1024;
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";
const CODEX_REQUIRES_INPUT_TOOLS_PATTERN = /^gpt-5\.6-(sol|terra|luna)(?:$|-)/i;
const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const CODEX_56_REASONING_EFFORTS = [...CODEX_REASONING_EFFORTS, "ultra"];
const CODEX_REQUEST_CONTEXT = Symbol("codexRequestContext");

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text"
]);

const CODEX_INPUT_ITEM_FIELD_ALLOWLIST = {
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL]: ["type", "call_id", "name", "input", "namespace", "caller"],
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT]: ["type", "call_id", "output", "caller"],
  [RESPONSES_ITEM.SHELL_CALL]: ["type", "call_id", "action", "environment", "status", "caller"],
  [RESPONSES_ITEM.SHELL_CALL_OUTPUT]: ["type", "call_id", "output", "max_output_length", "status", "caller"],
  [RESPONSES_ITEM.APPLY_PATCH_CALL]: ["type", "call_id", "operation", "status", "caller"],
  [RESPONSES_ITEM.APPLY_PATCH_CALL_OUTPUT]: ["type", "call_id", "status", "output", "caller"],
  [RESPONSES_ITEM.LOCAL_SHELL_CALL]: ["type", "id", "call_id", "action", "status"],
  [RESPONSES_ITEM.LOCAL_SHELL_CALL_OUTPUT]: ["type", "id", "output", "status"],
  [RESPONSES_ITEM.TOOL_SEARCH_CALL]: ["type", "call_id", "arguments", "execution", "status"],
  [RESPONSES_ITEM.MCP_LIST_TOOLS]: ["type", "id", "server_label", "tools", "error"],
  [RESPONSES_ITEM.MCP_APPROVAL_RESPONSE]: ["type", "approval_request_id", "approve", "reason"],
  [RESPONSES_ITEM.MCP_CALL]: ["type", "id", "arguments", "name", "server_label", "approval_request_id", "error", "output", "status"],
  [RESPONSES_ITEM.PROGRAM]: ["type", "id", "call_id", "code", "fingerprint"],
  [RESPONSES_ITEM.PROGRAM_OUTPUT]: ["type", "id", "call_id", "result", "status"],
};

const CODEX_INPUT_ITEM_REQUIRED_FIELDS = {
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL]: ["call_id", "name"],
  [RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT]: ["call_id"],
  [RESPONSES_ITEM.SHELL_CALL]: ["call_id", "action"],
  [RESPONSES_ITEM.SHELL_CALL_OUTPUT]: ["call_id", "output"],
  [RESPONSES_ITEM.APPLY_PATCH_CALL]: ["call_id", "operation"],
  [RESPONSES_ITEM.APPLY_PATCH_CALL_OUTPUT]: ["call_id", "status"],
  [RESPONSES_ITEM.LOCAL_SHELL_CALL]: ["id", "call_id", "action"],
  [RESPONSES_ITEM.LOCAL_SHELL_CALL_OUTPUT]: ["id", "output"],
  [RESPONSES_ITEM.TOOL_SEARCH_CALL]: ["arguments"],
  [RESPONSES_ITEM.MCP_LIST_TOOLS]: ["id", "server_label", "tools"],
  [RESPONSES_ITEM.MCP_APPROVAL_RESPONSE]: ["approval_request_id"],
  [RESPONSES_ITEM.MCP_CALL]: ["id", "arguments", "name", "server_label"],
  [RESPONSES_ITEM.PROGRAM]: ["id", "call_id", "code", "fingerprint"],
  [RESPONSES_ITEM.PROGRAM_OUTPUT]: ["id", "call_id", "result", "status"],
};

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

function extractCodexText(content) {
  if (typeof content === "string") return content.trim() === "" ? "..." : content;
  if (!Array.isArray(content)) return "";
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      if (typeof part.output === "string") return part.output;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || "";
}

function keepOnly(item, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) delete item[key];
  }
}

function hasCodexInputItemRequiredFields(item) {
  const required = CODEX_INPUT_ITEM_REQUIRED_FIELDS[item.type] || [];
  return required.every((key) => item[key] !== undefined && item[key] !== null && item[key] !== "");
}

function normalizeCodexOutputText(item) {
  if (typeof item.output !== "string") item.output = extractCodexText(item.output || item.content);
  if (typeof item.output !== "string") item.output = "";
}

function normalizeCodexNativeInputItem(item) {
  const fields = CODEX_INPUT_ITEM_FIELD_ALLOWLIST[item.type];
  if (!fields) return false;

  if (item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL && typeof item.input !== "string") item.input = "";
  if (item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) normalizeCodexOutputText(item);
  if (item.type === RESPONSES_ITEM.APPLY_PATCH_CALL_OUTPUT && item.status !== "failed") item.status = "completed";
  if (item.type === RESPONSES_ITEM.APPLY_PATCH_CALL_OUTPUT && item.output != null && typeof item.output !== "string") {
    item.output = extractCodexText(item.output);
  }

  keepOnly(item, fields);
  return hasCodexInputItemRequiredFields(item);
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexToolList(tools) {
  const validNames = new Set();
  const normalizedTools = tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (type === "tool_search") {
        if (tool.execution !== "server" && tool.execution !== "client") tool.execution = "client";
        return true;
      }
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });
  return { tools: normalizedTools, validNames };
}

function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const { tools, validNames } = normalizeCodexToolList(body.tools);
  body.tools = tools;
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

function getCodexReasoningEfforts(model) {
  return CODEX_REQUIRES_INPUT_TOOLS_PATTERN.test(String(model || ""))
    ? CODEX_56_REASONING_EFFORTS
    : CODEX_REASONING_EFFORTS;
}

function normalizeReasoningEffort(value, model) {
  if (value !== "max") return value;
  const levels = getCodexReasoningEfforts(model);
  return levels[levels.length - 1];
}

function ensureInputToolsForCodex56(body) {
  if (!CODEX_REQUIRES_INPUT_TOOLS_PATTERN.test(String(body?.model || ""))) return;
  if (!Array.isArray(body.input)) return;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== "additional_tools") continue;
    if (!Array.isArray(item.tools)) item.tools = tools;
  }
}

function normalizeCodex56BackendInput(body) {
  if (!CODEX_REQUIRES_INPUT_TOOLS_PATTERN.test(String(body?.model || ""))) return;
  if (!Array.isArray(body.input)) return;

  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;

    if (item.type === "additional_tools") {
      const { tools } = normalizeCodexToolList(Array.isArray(item.tools) ? item.tools : []);
      item.tools = tools;
      keepOnly(item, ["type", "role", "tools"]);
      return item.tools.length > 0;
    }

    if (item.type === "reasoning") {
      keepOnly(item, ["type", "summary", "encrypted_content"]);
      return !!item.encrypted_content || (Array.isArray(item.summary) && item.summary.length > 0);
    }

    if (item.type === "function_call_output") {
      normalizeCodexOutputText(item);
      keepOnly(item, ["type", "call_id", "output"]);
      return !!item.call_id;
    }

    if (item.type === "function_call") {
      keepOnly(item, ["type", "call_id", "name", "arguments"]);
      return !!item.call_id && !!item.name;
    }

    if (item.type === "message" || item.role) {
      if (!item.type) item.type = "message";
      item.content = extractCodexText(item.content) || "...";
      keepOnly(item, ["type", "role", "content", "name"]);
      return !!item.role;
    }

    return normalizeCodexNativeInputItem(item);
  });
}

function createRequestCredentials(body, credentials = {}) {
  const requestCredentials = { ...credentials };
  Object.defineProperty(requestCredentials, CODEX_REQUEST_CONTEXT, {
    value: {
      isCompact: !!body?._compact,
      sessionId: resolveCacheSessionId(body, credentials),
    },
  });
  return requestCredentials;
}

function getRequestContext(credentials) {
  return credentials?.[CODEX_REQUEST_CONTEXT] || null;
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSseErrorMessage(text, fallback) {
  const exact = text?.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
  if (exact) return exact;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || CODEX_MODEL_CAPACITY_MESSAGE;
}

function codexSseErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
  }

  /**
   * Override headers to add codex-specific identity headers.
   * Request-local session context is attached before BaseExecutor builds the URL.
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = getRequestContext(credentials)?.sessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return getRequestContext(credentials)?.isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    // BaseExecutor mutates the request body during transformation. Keep the
    // caller's top-level flags intact so token/account retries preserve /compact.
    const requestArgs = {
      ...args,
      body: { ...args.body },
    };
    requestArgs.credentials = createRequestCredentials(requestArgs.body, args.credentials);

    const requestContext = getRequestContext(requestArgs.credentials);
    const imgCount = Array.isArray(requestArgs.body?.input) ? requestArgs.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(requestArgs.body?.input) ? requestArgs.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${requestContext?.sessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(requestArgs.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(requestArgs.body);
    }

    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error)
    // Reuses 503 retry config — same semantic: upstream temporarily unavailable
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const { attempts, delayMs } = resolveRetryEntry(retryConfig[503]);
    let attempt = 0;
    while (true) {
      const result = await super.execute(requestArgs);
      const peek = await this._peekSseTransientError(result.response);
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE);
        return result;
      }
      if (attempt >= attempts) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
        return result;
      }
      attempt++;
      args.log?.debug?.("RETRY", `CODEX | SSE "${peek.matched}" retry ${attempt}/${attempts} after ${delayMs / 1000}s`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt}/${attempts} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Peek first N bytes of SSE body to detect upstream transient errors.
  // Returns { matched: string|null, message: string|null, accountFallback: boolean, replacementBody: ReadableStream|null }.
  // Caller must use replacementBody when no error matched (original body has been read).
  async _peekSseTransientError(response) {
    if (!response || !response.ok || !response.body) return { matched: null, message: null, accountFallback: false, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    let accountFallback = false;
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        const lowerText = text.toLowerCase();
        const outputIndex = Math.min(
          ...CODEX_SSE_USER_OUTPUT_PATTERNS
            .map((pattern) => lowerText.indexOf(pattern))
            .filter((index) => index >= 0),
        );
        const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS
          .map((pattern) => ({ pattern, index: lowerText.indexOf(pattern) }))
          .filter(({ index }) => index >= 0)
          .sort((a, b) => a.index - b.index)[0];
        const retryHit = CODEX_SSE_RETRY_PATTERNS
          .map((pattern) => ({ pattern, index: lowerText.indexOf(pattern) }))
          .filter(({ index }) => index >= 0)
          .sort((a, b) => a.index - b.index)[0];
        const errorHit = [accountHit, retryHit]
          .filter(Boolean)
          .sort((a, b) => a.index - b.index)[0];

        // Once real output starts, later error-looking text belongs to the model/tool payload.
        if (Number.isFinite(outputIndex) && (!errorHit || outputIndex < errorHit.index)) break;
        if (errorHit) {
          matched = errorHit.pattern;
          accountFallback = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.includes(errorHit.pattern);
          break;
        }
        if (Number.isFinite(outputIndex)) break;
      }
    } catch (e) {
      dbg("CODEX", `peek read error: ${e.message}`);
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return { matched, message: extractSseErrorMessage(text, matched), accountFallback, replacementBody: null };
    }

    reader.releaseLock();

    // Re-assemble stream: prefix chunks + remaining upstream body
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    const sessionId = getRequestContext(credentials)?.sessionId || resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && sessionId) {
      body.prompt_cache_key = sessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = getModelUpstreamId("cx", body.model || model);
    ensureInputToolsForCodex56(body);

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = getCodexReasoningEfforts(body.model);
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const effort = normalizeReasoningEffort(body.reasoning_effort || modelEffort || 'low', body.model);
      body.reasoning = { effort, summary: "auto" };
    } else {
      body.reasoning.effort = normalizeReasoningEffort(body.reasoning.effort, body.model);
      if (!body.reasoning.summary) body.reasoning.summary = "auto";
    }
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    if (body.service_tier === "fast") body.service_tier = "priority";
    if (body.service_tier && body.service_tier !== "priority") delete body.service_tier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    // GPT-5.6 Codex uses a stricter backend schema than public Responses.
    normalizeCodex56BackendInput(body);

    return body;
  }
}
