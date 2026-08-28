// Native-CLI provider fallback.
//
// Claude Code sends a bare model id (`claude-sonnet-5`), never a 9Router
// `provider/model` pair. Bare `claude-*` infers the `anthropic` provider (see
// services/model.js MODEL_PREFIX_PROVIDERS), which is right for a user holding
// an Anthropic API key — but wrong for the common case of a Claude Code relay
// or OAuth account living under the `claude` (`cc`) provider. Those users saw
// "No active credentials for provider: anthropic".
//
// This is expressed as a *fallback* rather than a rewrite on the way in: the
// inferred provider is still tried first, so nothing changes for an existing
// `anthropic` connection, and combo names / user model aliases still resolve
// ahead of it because they are consumed before credentials are looked up.

const NATIVE_CLI_FALLBACKS = [
  {
    clientTool: "claude",
    endpoint: /(?:^|\/)v1\/messages(?:\/|$)/,
    from: "anthropic",
    to: "claude",
    model: /^claude-/i,
  },
];

/**
 * Provider to retry with when the inferred provider has no credentials at all.
 *
 * @returns {string|null} fallback provider id, or null when none applies.
 */
export function resolveNativeCliFallbackProvider({
  provider,
  model,
  endpoint = "",
  clientTool = null,
} = {}) {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const match = NATIVE_CLI_FALLBACKS.find((rule) => (
    rule.clientTool === clientTool &&
    rule.from === provider &&
    rule.model.test(model) &&
    rule.endpoint.test(String(endpoint))
  ));
  return match ? match.to : null;
}
