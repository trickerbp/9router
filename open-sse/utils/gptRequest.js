import { GPT_6_ASTRA_PATTERN } from "../config/gptModels.js";
import { FORMATS } from "../translator/formats.js";

export function normalizeGptRequest(body, model, format) {
  if (!GPT_6_ASTRA_PATTERN.test(model)) return;
  if (format !== FORMATS.OPENAI && format !== FORMATS.OPENAI_RESPONSES) return;
  delete body.temperature;
  delete body.top_p;
  delete body.top_logprobs;
  delete body.logprobs;
  if (Array.isArray(body.include)) body.include = body.include.filter(item => item !== "message.output_text.logprobs");
  if (["none", "minimal"].includes(body.reasoning?.effort)) body.reasoning.effort = "low";
  if (["none", "minimal"].includes(body.reasoning_effort)) body.reasoning_effort = "low";
  if (body.prompt_cache_retention && !body.prompt_cache_options) body.prompt_cache_options = { ttl: "30m" };
  delete body.prompt_cache_retention;
}

export function gptEndpointError(body, model, targetFormat) {
  if (!GPT_6_ASTRA_PATTERN.test(model) || targetFormat === FORMATS.OPENAI_RESPONSES) return null;
  if (body.tools?.length || body.messages?.some(item => item.tool_calls?.length || item.role === "tool") ||
      body.input?.some?.(item => /tool|function|shell|patch/.test(item?.type || ""))) {
    return "continuity_not_supported: GPT-6 Astra tool calling requires a Responses-compatible endpoint";
  }
  return null;
}
