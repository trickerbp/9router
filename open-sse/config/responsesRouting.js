// Limits apply to the whole Responses request, including account and URL retries.
export const RESPONSES_ROUTING = {
  maxAttempts: 8,
  deadlineMs: 10 * 60 * 1000,
  retriesPerAccount: 1,
  exhaustedCooldownMs: 60 * 60 * 1000,
  affinityTtlMs: 2 * 60 * 60 * 1000,
  affinityMaxEntries: 5000,
  peekBytes: 256 * 1024,
};

export const QUOTA_ERROR_PATTERN = /usage_limit_reached|insufficient_(?:user_)?quota|quota[_ ](?:exceeded|exhausted)|(?:credit|balance|budget).*(?:exhausted|insufficient|depleted|exceeded)|(?:insufficient|exhausted).*(?:credit|balance|budget)|billing_hard_limit|spending[_ -]limit|余额不足|额度不足/i;
export const CONTEXT_ERROR_PATTERN = /context_length_exceeded|maximum context length|context window|invalid_encrypted_content|encrypted content.*(?:invalid|decrypt)|continuity_not_supported|previous_response_id|item_reference/i;
export const TRANSIENT_ERROR_PATTERN = /server_is_overloaded|service_unavailable_error|model_at_capacity|model_capacity_exceeded|selected model is at capacity|overloaded/i;
