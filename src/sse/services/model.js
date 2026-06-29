// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

function normalizeBareCodexModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return raw;
  if (/^5\.\d+(?:-.+)?$/i.test(raw)) return `gpt-${raw}`;
  if (/^gpt5(?:\.\d+)?$/i.test(raw)) {
    return raw.toLowerCase().replace(/^gpt/, "gpt-");
  }
  return raw;
}

function hasProviderModel(providerAlias, model) {
  const target = String(model || "").toLowerCase();
  return (PROVIDER_MODELS[providerAlias] || []).some((entry) => {
    if ((entry.type || "llm") !== "llm") return false;
    return String(entry.id || "").toLowerCase() === target;
  });
}

function isCodexOnlyModel(model) {
  const normalized = normalizeBareCodexModel(model);
  return hasProviderModel("cx", normalized) && !hasProviderModel("openai", normalized);
}

function rerouteCodexOnlyOpenAI(info) {
  if (!info || info.provider !== "openai" || !isCodexOnlyModel(info.model)) return info;
  return { ...info, provider: "codex", model: normalizeBareCodexModel(info.model) };
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return rerouteCodexOnlyOpenAI({
      provider: parsed.provider,
      model: normalizeBareCodexModel(parsed.model)
    });
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  const normalizedCodexModel = normalizeBareCodexModel(parsed.model);
  if (isCodexOnlyModel(normalizedCodexModel)) {
    return { provider: "codex", model: normalizedCodexModel };
  }

  const resolved = await getModelInfoCore(modelStr, getModelAliases);
  return rerouteCodexOnlyOpenAI(resolved);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
