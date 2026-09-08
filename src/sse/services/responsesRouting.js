import { createHash } from "node:crypto";
import { RESPONSES_ROUTING } from "open-sse/config/responsesRouting.js";
import { createRequestBudget } from "open-sse/utils/requestBudget.js";

const budgets = new WeakMap();
const sessions = new Map();

export function getRoutingBudget(request) {
  if (!request) return createRequestBudget();
  if (!budgets.has(request)) budgets.set(request, createRequestBudget(request.signal));
  return budgets.get(request);
}

export function routingSessionKey(provider, model, headers, body, apiKey) {
  if (!["codex", "openai"].includes(provider) && !provider.startsWith("openai-compatible-")) return null;
  const session = headers?.["x-session-id"] || headers?.["session-id"] || headers?.session_id || body.prompt_cache_key || body.session_id || body.conversation_id;
  if (typeof session !== "string" || !session.trim() || session.length > 256) return null;
  return createHash("sha256").update(JSON.stringify([apiKey || "local", provider, model, session])).digest("hex");
}

export function preferredSessionConnection(key) {
  const entry = key && sessions.get(key);
  if (!entry) return null;
  if (Date.now() - entry.usedAt > RESPONSES_ROUTING.affinityTtlMs) { sessions.delete(key); return null; }
  return entry.connectionId;
}

export function bindSessionConnection(key, connectionId) {
  if (!key) return;
  sessions.delete(key);
  if (!connectionId) return;
  while (sessions.size >= RESPONSES_ROUTING.affinityMaxEntries) sessions.delete(sessions.keys().next().value);
  sessions.set(key, { connectionId, usedAt: Date.now() });
}
