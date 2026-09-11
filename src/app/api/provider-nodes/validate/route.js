import { NextResponse } from "next/server";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";

// Fetch with timeout wrapper
const fetchWithTimeout = (url, options, timeout = 10000) => {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Request timeout")), timeout)
    )
  ]);
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

const getInferenceErrorMessage = (status, endpoint) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return `${endpoint} endpoint not found`;
  if (status >= 500) return "Server error - try again later";
  return `Inference request failed (${status})`;
};

// POST /api/provider-nodes/validate - Validate API key against base URL
export async function POST(request) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, type, apiType, modelId } = body;

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: "Base URL and API key required" }, { status: 400 });
    }

    if (!modelId?.trim()) {
      return NextResponse.json({ error: "Model ID is required to check this provider" }, { status: 400 });
    }

    const selectedModelId = modelId.trim();

    // Validate URL format
    if (!isValidUrl(baseUrl)) {
      return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
    }

    // SSRF guard for remote callers; local host keeps self-hosted nodes (e.g. ollama-local)
    if (!isLocalRequest(request)) {
      try {
        assertPublicUrl(baseUrl);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      const normalizedBase = baseUrl.trim().replace(/\/$/, "");
      const embedRes = await fetchWithTimeout(`${normalizedBase}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: selectedModelId, input: "ping" })
      });
      if (embedRes.ok) {
        const data = await embedRes.json().catch(() => null);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
        return NextResponse.json({ valid: true, method: "embeddings", dimensions: dims });
      }
      if (embedRes.status === 401 || embedRes.status === 403) {
        return NextResponse.json({ valid: false, error: "API key unauthorized" });
      }
      const errBody = await embedRes.text().catch(() => "");
      return NextResponse.json({
        valid: false,
        error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        method: "embeddings"
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      let normalizedBase = baseUrl.trim().replace(/\/$/, "");
      if (normalizedBase.endsWith("/messages")) {
        normalizedBase = normalizedBase.slice(0, -9);
      }

      const messagesRes = await fetchWithTimeout(`${normalizedBase}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        })
      });

      if (messagesRes.ok) return NextResponse.json({ valid: true, method: "messages" });
      return NextResponse.json({
        valid: false,
        error: getInferenceErrorMessage(messagesRes.status, "Messages"),
        method: "messages"
      });
    }

    // OpenAI-compatible providers are checked by inference with the model the
    // user selected. /models only proves a key can list models, not that the
    // selected model can generate a response.
    const normalizedBase = baseUrl.trim().replace(/\/$/, "");
    const usesResponsesApi = apiType === "responses";
    const endpoint = usesResponsesApi ? "Responses" : "Chat Completions";
    const inferenceRes = await fetchWithTimeout(
      `${normalizedBase}/${usesResponsesApi ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(usesResponsesApi
          ? { model: selectedModelId, input: "ping", max_output_tokens: 1 }
          : { model: selectedModelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }
        )
      }
    );

    if (inferenceRes.ok) return NextResponse.json({ valid: true, method: usesResponsesApi ? "responses" : "chat" });
    return NextResponse.json({
      valid: false,
      error: getInferenceErrorMessage(inferenceRes.status, endpoint),
      method: usesResponsesApi ? "responses" : "chat"
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return NextResponse.json({ 
      valid: false,
      error: errorMessage 
    }, { status: 500 });
  }
}
