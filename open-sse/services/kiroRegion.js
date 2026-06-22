export const DEFAULT_KIRO_REGION = "us-east-1";
export const DEFAULT_KIRO_OIDC_REGION = "us-east-1";

// AWS region allowlist pattern — prevents SSRF via region injection into upstream
// URLs (GHSA-6mwv-4mrm-5p3m). Any value that isn't a well-formed AWS region is
// rejected centrally here, so every URL builder + OIDC refresh path is covered.
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function regionFromProfileArn(profileArn) {
  if (!profileArn || typeof profileArn !== "string") return null;
  const parts = profileArn.split(":");
  if (parts.length >= 4 && parts[2] === "codewhisperer" && parts[3]) return parts[3];
  return null;
}

function normalizeRegion(region) {
  if (typeof region !== "string") return null;
  const trimmed = region.trim();
  if (!trimmed || !AWS_REGION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function getProviderData(input) {
  if (!input || typeof input !== "object") return {};
  return input.providerSpecificData && typeof input.providerSpecificData === "object"
    ? input.providerSpecificData
    : input;
}

export function resolveKiroRegion(input) {
  const data = getProviderData(input);
  return normalizeRegion(data.kiroRegion)
    || normalizeRegion(data.kiro_region)
    || normalizeRegion(data.kirRegion)
    || normalizeRegion(data.qRegion)
    || normalizeRegion(data.q_region)
    || normalizeRegion(regionFromProfileArn(data.profileArn || data.profile_arn))
    || normalizeRegion(data.region)
    || DEFAULT_KIRO_REGION;
}

export function resolveKiroOidcRegion(input) {
  const data = getProviderData(input);
  return normalizeRegion(data.oidcRegion)
    || normalizeRegion(data.oidc_region)
    || normalizeRegion(data.idcRegion)
    || normalizeRegion(data.idc_region)
    || normalizeRegion(data.region)
    || DEFAULT_KIRO_OIDC_REGION;
}

export function buildKiroQUrl(input, path = "") {
  const region = resolveKiroRegion(input);
  const suffix = path ? `/${String(path).replace(/^\/+/, "")}` : "";
  return `https://q.${region}.amazonaws.com${suffix}`;
}

export function buildKiroCodeWhispererUrl(input, path = "") {
  const region = resolveKiroRegion(input);
  const suffix = path ? `/${String(path).replace(/^\/+/, "")}` : "";
  return `https://codewhisperer.${region}.amazonaws.com${suffix}`;
}
