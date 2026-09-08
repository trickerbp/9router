import { CONTEXT_ERROR_PATTERN, QUOTA_ERROR_PATTERN, TRANSIENT_ERROR_PATTERN } from "../config/responsesRouting.js";

// Inspect error envelopes only. Never classify assistant text as an upstream error.
export function getErrorEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  const error = value.error || value.response?.error || value.data?.error;
  if (error) return typeof error === "string" ? { message: error } : error;
  if (value.type === "error") return value;
  if (["failed", "incomplete"].includes(value.status || value.response?.status) || ["response.failed", "response.incomplete"].includes(value.type)) {
    return { code: value.incomplete_details?.reason || value.response?.incomplete_details?.reason || "upstream_incomplete", message: "Upstream response did not complete" };
  }
  if (value.success === false) return { code: value.code, message: value.message || value.msg || "Upstream request failed" };
  // Some relays return {code: 402, msg: ...} with HTTP 200. Require a
  // structured failure marker; normal response/output text is never scanned.
  if (!value.output && !value.choices && !value.delta && typeof (value.message || value.msg) === "string" &&
      ((Number(value.code) >= 400 && Number(value.code) < 600) || QUOTA_ERROR_PATTERN.test(String(value.code || "")))) return value;
  return null;
}

export function parseProviderError(status, body, headers = null, now = Date.now()) {
  let value = body;
  if (typeof body === "string") {
    try { value = JSON.parse(body); } catch { value = { message: body }; }
  }
  const err = getErrorEnvelope(value) || value || {};
  const embeddedStatus = Number(err.status || err.status_code || err.code);
  if (status < 400 && embeddedStatus >= 400 && embeddedStatus < 600) status = embeddedStatus;
  const message = typeof err.message === "string" ? err.message : typeof err.msg === "string" ? err.msg : typeof body === "string" ? body : `HTTP ${status}`;
  const code = String(err.code || err.type || "");
  const signature = `${code} ${message}`;
  let category = "unknown";
  if (status === 499 || /request aborted|client.disconnected|routing_budget_exhausted/i.test(signature)) category = "cancelled";
  else if (CONTEXT_ERROR_PATTERN.test(signature)) category = "context";
  else if (QUOTA_ERROR_PATTERN.test(signature) || status === 402) category = "quota";
  else if (status === 401 || /invalid_api_key|token_invalid|authentication_error/i.test(signature)) category = "auth";
  else if (status === 429 || /rate_limit|rate limit|too many requests/i.test(signature)) category = "rate_limit";
  else if (TRANSIENT_ERROR_PATTERN.test(signature) || status >= 500 || status === 408) category = "transient";
  else if (status === 403) category = "permission";
  else if (status === 404 || status === 406) category = "model";
  else if (status >= 400 && status < 500) category = "request";
  if (["quota", "context", "cancelled", "auth", "rate_limit", "transient", "request", "permission", "model"].includes(err.category || err.type)) category = err.category || err.type;

  const derivedStatus = { quota: 429, auth: 401, rate_limit: 429, transient: 503, context: 400, request: 400, cancelled: 499 }[category] || 502;
  const httpStatus = status >= 400 ? status : derivedStatus;
  let resetsAtMs = null;
  const reset = Number(err.resets_at ?? err.reset_at);
  if (Number.isFinite(reset) && reset > 0) resetsAtMs = reset < 1e12 ? reset * 1000 : reset;
  const seconds = Number(err.resets_in_seconds ?? err.retry_after);
  if ((!resetsAtMs || resetsAtMs <= now) && seconds > 0) resetsAtMs = now + seconds * 1000;
  const retryAfter = headers?.get?.("retry-after");
  if ((!resetsAtMs || resetsAtMs <= now) && retryAfter) {
    const seconds = Number(retryAfter);
    resetsAtMs = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
  }
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) resetsAtMs = null;
  // Billing/auth apply across models; usage_limit_reached can refer to a separate model quota family.
  const scope = err.scope === "account" || category === "auth" || status === 402 || /insufficient_quota|billing_hard_limit|(?:credit|balance|budget)|余额|额度/i.test(signature) ? "account" : "model";
  return { status: httpStatus, message, code, category, scope, resetsAtMs };
}

export function providerErrorResponse(error) {
  return new Response(JSON.stringify({ error: {
    message: error.message, code: error.code, type: error.category, scope: error.scope,
    ...(error.resetsAtMs ? { resets_at: error.resetsAtMs / 1000 } : {}),
  } }), { status: error.status, headers: { "Content-Type": "application/json" } });
}
