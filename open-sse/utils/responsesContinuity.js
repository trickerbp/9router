import { FORMATS } from "../translator/formats.js";

export function responsesContinuityError(body, sourceFormat, targetFormat) {
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES) return null;
  if (body.previous_response_id || body.conversation || (Array.isArray(body.input) && body.input.some(item => typeof item === "string" || item?.type === "item_reference"))) {
    return "continuity_not_supported: account routing requires the complete input history (including tool results and compaction output), without previous_response_id, conversation or item_reference. Resume with the full history.";
  }
  if (targetFormat === FORMATS.OPENAI_RESPONSES) return null;
  if (body._compact) return "continuity_not_supported: this endpoint cannot compact Responses history. Select a Responses-compatible connection.";
  if (body.tools?.some(tool => tool.type !== "function" || tool.async || tool.defer_loading)) {
    return "continuity_not_supported: native Responses tools require a Responses-compatible connection";
  }
  const supported = new Set(["message", "function_call", "function_call_output"]);
  if (Array.isArray(body.input) && body.input.some(item => item && (
    item.encrypted_content || item.phase || item.namespace || item.caller ||
    (item.type === "function_call_output" && typeof item.output !== "string") ||
    (item.type && !supported.has(item.type))
  ))) {
    return "continuity_not_supported: this conversation contains Responses state that cannot be represented by the selected endpoint. Select a Responses-compatible connection or resume from a complete text checkpoint.";
  }
  return null;
}
