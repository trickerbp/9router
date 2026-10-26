// JSON Schema keywords that must carry numeric values.
//
// Some clients serialize JSON Schema through protobuf JSON (protojson), which
// renders every number as a string: { "minLength": "1" }. Strict validators
// (Codex / Responses) reject the whole request with
//   Invalid schema for function 'send_message': "1" is not of type "integer".
export const NUMERIC_JSON_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "multipleOf",
];
