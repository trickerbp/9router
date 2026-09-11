import { NextResponse } from "next/server";
import { createProviderConnection, createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

async function createInitialCompatibleConnection(node, apiKey, modelId) {
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const trimmedModelId = typeof modelId === "string" ? modelId.trim() : "";

  // Preserve the node-only API for existing clients, while ensuring the dashboard
  // never drops a supplied key. A partial credential payload is always invalid.
  if (!trimmedKey && !trimmedModelId) return null;
  if (!trimmedKey || !trimmedModelId) {
    throw new Error("API key and model ID must be supplied together");
  }

  const providerSpecificData = {
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  };
  if (node.type === "openai-compatible") {
    providerSpecificData.apiType = node.apiType;
  }

  return createProviderConnection({
    provider: node.id,
    authType: "apikey",
    name: `${node.name} API Key`,
    apiKey: trimmedKey,
    defaultModel: trimmedModelId,
    providerSpecificData,
    isActive: true,
    testStatus: "unknown",
  });
}

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type, apiKey, modelId } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";
    const isCompatibleNode = nodeType === "openai-compatible" || nodeType === "anthropic-compatible";
    const hasApiKey = typeof apiKey === "string" && apiKey.trim() !== "";
    const hasModelId = typeof modelId === "string" && modelId.trim() !== "";

    if (isCompatibleNode && hasApiKey !== hasModelId) {
      return NextResponse.json({ error: "API key and model ID must be supplied together" }, { status: 400 });
    }

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
      });
      const connection = await createInitialCompatibleConnection(node, apiKey, modelId);
      const result = connection ? { ...connection, apiKey: undefined } : null;
      return NextResponse.json({ node, connection: result }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      const connection = await createInitialCompatibleConnection(node, apiKey, modelId);
      const result = connection ? { ...connection, apiKey: undefined } : null;
      return NextResponse.json({ node, connection: result }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    if (error.message === "API key and model ID must be supplied together") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
