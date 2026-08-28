import { CLAUDE_CLI_SPOOF_HEADERS } from "./shared.js";
import { applyRelayAuthHeaders, normalizeRelayBaseUrl, RELAY_PROVIDER_PATHS } from "./relay.js";
import { getDefaultModel } from "../config/providerModels.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ERROR_TEXT = 500;
const MODEL_ALIASES = { claude: "cc", codex: "cx" };

function defaultRelayModel(provider) {
  return getDefaultModel(provider) || getDefaultModel(MODEL_ALIASES[provider] || provider);
}

function codexIdentityHeaders() {
  return {
    "User-Agent": "codex_cli_rs/0.136.0",
    originator: "codex_cli_rs",
    session_id: "relay-validation",
  };
}

function stripProviderPrefix(provider, model) {
  if (typeof model !== "string") return model;
  const prefixes = provider === "claude"
    ? ["cc/", "claude/"]
    : provider === "codex"
      ? ["cx/", "codex/"]
      : [];
  const prefix = prefixes.find((value) => model.startsWith(value));
  return prefix ? model.slice(prefix.length) : model;
}

function buildProbeBody(provider, model) {
  if (provider === "claude") {
    return {
      model,
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    };
  }

  return {
    model,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "ping" }],
    }],
    instructions: "Reply with OK.",
    stream: true,
    store: false,
  };
}

/**
 * Build the smallest real inference request for a first-party CLI relay.
 * Keeping this pure makes the exact wire contract testable without network I/O.
 */
export function buildRelayProbeRequest({ provider, baseUrl, apiKey, model, preferredModel } = {}) {
  const selectedModel = stripProviderPrefix(
    provider,
    model || preferredModel || defaultRelayModel(provider),
  );
  const normalizedBase = normalizeRelayBaseUrl(provider, baseUrl);
  if (!normalizedBase || !RELAY_PROVIDER_PATHS[provider]) {
    return { error: "A valid relay Base URL is required" };
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { error: "An API key is required" };
  }
  if (typeof selectedModel !== "string" || !selectedModel.trim()) {
    return { error: "A default model is required" };
  }

  const headers = {
    "Content-Type": "application/json",
    ...(provider === "claude" ? CLAUDE_CLI_SPOOF_HEADERS : codexIdentityHeaders()),
  };
  applyRelayAuthHeaders(headers, { apiKey: apiKey.trim() });
  if (provider === "codex") headers.Accept = "text/event-stream";

  return {
    url: `${normalizedBase}${RELAY_PROVIDER_PATHS[provider]}`,
    options: {
      method: "POST",
      headers,
      body: JSON.stringify(buildProbeBody(provider, selectedModel.trim())),
    },
    model: selectedModel.trim(),
  };
}

// Optional helper for callers that already fetched a relay catalog. Validation
// itself intentionally does not depend on /models because many relays omit it.
export function selectRelayProbeModel(provider, catalog, preferredModel = null) {
  if (typeof preferredModel === "string" && preferredModel.trim()) return preferredModel.trim();
  const ids = Array.isArray(catalog?.data)
    ? catalog.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
    : [];
  const prefix = provider === "claude" ? "cc/" : provider === "codex" ? "cx/" : "";
  return ids.find((id) => !prefix || id.startsWith(prefix)) || ids[0] || null;
}

async function readResponseText(response) {
  try {
    const text = await response.text();
    return typeof text === "string" ? text.slice(0, MAX_ERROR_TEXT) : "";
  } catch {
    return "";
  }
}

/** A relay serving its web app on the endpoint path is not a working endpoint. */
function looksLikeHtml(response, text) {
  const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) return true;
  return /^\s*(?:<!doctype html|<html\b)/i.test(String(text || ""));
}

function extractMessage(text, secret = "") {
  if (!text) return null;
  const redact = (value) => secret ? value.replaceAll(secret, "[redacted]") : value;
  try {
    const parsed = JSON.parse(text);
    const candidates = [
      parsed?.error?.message,
      parsed?.error?.detail,
      typeof parsed?.error === "string" ? parsed.error : null,
      parsed?.message,
      parsed?.detail,
    ];
    const message = candidates.find((value) => typeof value === "string" && value.trim());
    if (message) return redact(message.trim()).slice(0, MAX_ERROR_TEXT);
  } catch {
    // Relays may return an HTML or plain-text error; use it as-is below.
  }
  const compact = redact(text.replace(/\s+/g, " ").trim());
  return compact ? compact.slice(0, MAX_ERROR_TEXT) : null;
}

/**
 * Execute a real relay inference probe. Any non-2xx status is unavailable,
 * including 404 and 429; a catalogue endpoint alone is not an auth check.
 */
export async function probeRelayConnection({
  provider,
  baseUrl,
  apiKey,
  model,
  preferredModel,
  fetchImpl = globalThis.fetch,
  fetchFn,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const request = buildRelayProbeRequest({ provider, baseUrl, apiKey, model, preferredModel });
  if (request.error) return { valid: false, error: request.error };
  const fetcher = fetchFn || fetchImpl;
  if (typeof fetcher !== "function") return { valid: false, error: "Fetch is unavailable" };

  try {
    const requestSignal = signal || (typeof AbortSignal?.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);
    const response = await fetcher(request.url, {
      ...request.options,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
    const text = await readResponseText(response);
    const status = Number(response?.status) || 0;
    const ok = response?.ok === true || (status >= 200 && status < 300);
    // A relay whose base URL is missing the /v1 (or other) prefix answers the
    // POST with its own dashboard SPA — HTTP 200, text/html. Treating that as a
    // working endpoint is the one false positive that matters here, because the
    // user then saves a Base URL that fails on every real request.
    if (ok && looksLikeHtml(response, text)) {
      return {
        valid: false,
        status,
        model: request.model,
        error: `Relay returned an HTML page at ${request.url} instead of an API response — check whether the Base URL needs a /v1 suffix`,
      };
    }
    if (ok) return { valid: true, status, model: request.model, error: null };

    const detail = extractMessage(text, apiKey);
    return {
      valid: false,
      status,
      model: request.model,
      error: `Relay returned HTTP ${status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Relay unreachable: ${error?.message || "request failed"}`,
    };
  }
}
