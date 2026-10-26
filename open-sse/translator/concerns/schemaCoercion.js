import { NUMERIC_JSON_SCHEMA_KEYWORDS } from "../../config/schemaConstants.js";

const NUMERIC_KEYWORD_SET = new Set(NUMERIC_JSON_SCHEMA_KEYWORDS);

// "1" -> 1, "" / "abc" -> unchanged.
function coerceKeywordValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : value;
}

/**
 * Restore numeric typing for schema keywords that protojson serialized as strings.
 * Mutates the schema in place and returns it.
 */
export function coerceNumericSchemaKeywords(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) schema[i] = coerceNumericSchemaKeywords(schema[i]);
    return schema;
  }
  for (const key of Object.keys(schema)) {
    const value = schema[key];
    if (NUMERIC_KEYWORD_SET.has(key)) {
      schema[key] = coerceKeywordValue(value);
    } else if (value && typeof value === "object") {
      coerceNumericSchemaKeywords(value);
    }
  }
  return schema;
}

function coerceTool(tool) {
  if (!tool || typeof tool !== "object") return;
  if (tool.parameters) coerceNumericSchemaKeywords(tool.parameters);
  if (tool.function?.parameters) coerceNumericSchemaKeywords(tool.function.parameters);
  if (Array.isArray(tool.tools)) for (const nested of tool.tools) coerceTool(nested);
}

/**
 * Coerce tool parameter schemas in a Responses-style body: top-level `tools`
 * plus the `additional_tools` input items some clients (Antigravity, VS Code)
 * send instead. Mutates the body in place and returns it.
 */
export function coerceToolSchemaNumerics(body) {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body.tools)) for (const tool of body.tools) coerceTool(tool);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
        for (const tool of item.tools) coerceTool(tool);
      }
    }
  }
  return body;
}
