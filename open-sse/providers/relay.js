// Per-connection relay Base URL for the first-party CLI providers (Claude Code,
// Codex).
//
// A relay resells CLI access behind a front door shaped like the upstream it
// proxies: you are handed a base URL ending in /v1 plus a bearer token, and the
// wire format is unchanged. Pointing the `claude` / `codex` provider at that
// host — rather than creating an anthropic-compatible / openai-compatible node —
// is what keeps the CLI-specific request shape intact: the
// claude-code-20250219 beta flag and Claude Code identity headers, the Codex
// `instructions` + store:false contract, the originator/session_id headers. The
// compat-node path deliberately strips those (see executors/default.js
// buildHeaders), because a generic third-party gateway rejects them — which is
// exactly what a CLI-reselling relay expects to receive.
//
// The override lives on the connection (providerSpecificData.baseUrl), not on
// the provider, so relay keys and real OAuth accounts coexist under one provider
// and take part in the same account-fallback loop.
//
// Deliberately import-free so providers/shared.js, the registry and the app
// layer can all reach it without a cycle.

// provider id → path appended to the user's base URL (which ends at /v1).
export const RELAY_PROVIDER_PATHS = {
  claude: "/messages",
  codex: "/responses",
};

export function supportsRelayBaseUrl(provider) {
  return typeof provider === "string" && provider in RELAY_PROVIDER_PATHS;
}

/**
 * Normalize a user-entered base URL to the root the endpoint path hangs off.
 *
 * Whatever the user pastes is taken verbatim: /v1 is neither required nor added,
 * because relays differ on whether they serve at /v1 or at the domain root.
 * Only a trailing slash and a trailing copy of the endpoint path are trimmed, so
 * pasting the full endpoint cannot produce /messages/messages.
 *
 * @returns {string|null} normalized root, or null when there is nothing usable.
 */
export function normalizeRelayBaseUrl(provider, rawBaseUrl) {
  if (!supportsRelayBaseUrl(provider)) return null;
  if (typeof rawBaseUrl !== "string") return null;
  let base = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  const path = RELAY_PROVIDER_PATHS[provider];
  if (base.endsWith(path)) base = base.slice(0, -path.length).replace(/\/+$/, "");
  return base || null;
}

/**
 * Full upstream URL for a relay connection, or null when this connection has no
 * relay override (i.e. use the registry baseUrl as usual).
 */
export function resolveRelayUrl(provider, credentials) {
  const base = normalizeRelayBaseUrl(provider, credentials?.providerSpecificData?.baseUrl);
  return base ? `${base}${RELAY_PROVIDER_PATHS[provider]}` : null;
}

/** Root URL used for side-channel probes (/models, validation) on a relay connection. */
export function resolveRelayBaseUrl(provider, providerSpecificData) {
  return normalizeRelayBaseUrl(provider, providerSpecificData?.baseUrl);
}

/**
 * Relays disagree on where the credential goes: Anthropic-shaped ones read
 * x-api-key, OpenAI-shaped ones read Authorization, and some read either. Send
 * both — neither header is meaningful to the other scheme, so the superset is
 * what makes an arbitrary relay work without asking the user which it wants.
 * Never overwrites a header the caller already set.
 */
export function applyRelayAuthHeaders(headers, credentials) {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) return headers;
  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (!headers["x-api-key"] && !headers["X-Api-Key"]) {
    headers["x-api-key"] = token;
  }
  return headers;
}
