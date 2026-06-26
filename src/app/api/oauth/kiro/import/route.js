import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";
import { regionFromProfileArn } from "open-sse/services/kiroRegion.js";

function pick(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function unwrapImportPayload(input) {
  if (Array.isArray(input)) return input.find((item) => item && typeof item === "object" && !Array.isArray(item)) || {};
  return input && typeof input === "object" ? input : {};
}

function normalizeImportPayload(rawBody) {
  const body = unwrapImportPayload(rawBody);
  const psd = body?.providerSpecificData && typeof body.providerSpecificData === "object"
    ? body.providerSpecificData
    : {};

  const profileArn = pick(body, "profileArn", "profile_arn") || pick(psd, "profileArn");
  const kiroRegion = pick(body, "kiroRegion", "kiro_region", "region")
    || pick(psd, "kiroRegion")
    || regionFromProfileArn(profileArn)
    || "us-east-1";
  const oidcRegion = pick(body, "oidcRegion", "oidc_region", "idcRegion")
    || pick(psd, "oidcRegion", "region")
    || "us-east-1";

  return {
    accessToken: pick(body, "accessToken", "access_token"),
    refreshToken: pick(body, "refreshToken", "refresh_token"),
    expiresAt: pick(body, "expiresAt", "expires_at"),
    expiresIn: Number(pick(body, "expiresIn", "expires_in")) || null,
    email: pick(body, "email"),
    profileArn,
    clientId: pick(body, "clientId", "client_id") || pick(psd, "clientId"),
    clientSecret: pick(body, "clientSecret", "client_secret") || pick(psd, "clientSecret"),
    authMethod: pick(body, "authMethod", "auth_method") || pick(psd, "authMethod") || "imported",
    providerName: pick(body, "provider") || pick(psd, "provider"),
    startUrl: pick(body, "startUrl", "start_url") || pick(psd, "startUrl"),
    tokenEndpoint: pick(body, "tokenEndpoint", "token_endpoint") || pick(psd, "tokenEndpoint"),
    issuerUrl: pick(body, "issuerUrl", "issuer_url") || pick(psd, "issuerUrl"),
    scopes: pick(body, "scopes", "scope") || pick(psd, "scopes"),
    oidcRegion,
    kiroRegion,
  };
}

function getExpiresAt(input) {
  if (input.expiresAt) {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isNaN(expiresAt.getTime())) return expiresAt.toISOString();
  }
  const expiresIn = input.expiresIn || 3600;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token from Kiro IDE
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const imported = normalizeImportPayload(body || {});

    if (!imported.refreshToken || typeof imported.refreshToken !== "string") {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();

    let tokenData;
    let tokenRefreshed = false;
    const refreshToken = imported.refreshToken.trim();
    const isExternalIdp = imported.authMethod === "external_idp"
      || (!!imported.tokenEndpoint && !!imported.clientId && !imported.clientSecret);

    const durablePsd = {
      profileArn: imported.profileArn,
      clientId: imported.clientId,
      clientSecret: imported.clientSecret,
      authMethod: isExternalIdp ? "external_idp" : imported.authMethod,
      provider: imported.providerName
        || (isExternalIdp ? "External IdP" : imported.authMethod === "idc" ? "AWS IAM Identity Center" : "Imported"),
      startUrl: imported.startUrl,
      region: imported.oidcRegion,
      oidcRegion: imported.oidcRegion,
      kiroRegion: imported.kiroRegion,
      tokenEndpoint: imported.tokenEndpoint,
      issuerUrl: imported.issuerUrl,
      scopes: imported.scopes,
    };

    if (isExternalIdp) {
      // Microsoft 365 / Entra ID: refresh against the IdP token endpoint to
      // validate the refresh token and obtain a fresh access token.
      try {
        const refreshed = await kiroService.refreshToken(refreshToken, durablePsd);
        tokenData = {
          accessToken: refreshed.accessToken || imported.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn || imported.expiresIn || 3600,
          profileArn: imported.profileArn,
          authMethod: "external_idp",
        };
        tokenRefreshed = !!refreshed.accessToken;
      } catch (error) {
        if (!imported.accessToken) throw error;
        // Fall back to the supplied (still-valid) access token if refresh fails.
        tokenData = {
          accessToken: imported.accessToken,
          refreshToken,
          expiresIn: imported.expiresIn || 3600,
          profileArn: imported.profileArn,
          authMethod: "external_idp",
        };
      }

      // External IdP tokens carry no profile ARN; resolve it via
      // ListAvailableProfiles when the caller didn't supply one.
      if (!tokenData.profileArn && tokenData.accessToken) {
        try {
          const resolvedArn = await kiroService.listAvailableProfiles(
            tokenData.accessToken,
            imported.kiroRegion || "us-east-1",
            true
          );
          if (resolvedArn) {
            tokenData.profileArn = resolvedArn;
            durablePsd.profileArn = resolvedArn;
            const resolvedRegion = regionFromProfileArn(resolvedArn);
            if (resolvedRegion) durablePsd.kiroRegion = resolvedRegion;
          }
        } catch (error) {
          console.log("Kiro external IdP profile ARN resolution failed:", error.message);
        }
      }
    } else if (imported.clientId && imported.clientSecret) {
      try {
        const refreshed = await kiroService.refreshToken(refreshToken, durablePsd);
        tokenData = {
          accessToken: refreshed.accessToken || imported.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn || imported.expiresIn || 3600,
          profileArn: imported.profileArn,
          authMethod: imported.authMethod || "idc",
        };
        tokenRefreshed = !!refreshed.accessToken;
      } catch (error) {
        if (!imported.accessToken) throw error;
        tokenData = {
          accessToken: imported.accessToken,
          refreshToken,
          expiresIn: imported.expiresIn || 3600,
          profileArn: imported.profileArn,
          authMethod: imported.authMethod || "idc",
        };
      }
    } else {
      // Legacy path: paste the Kiro social refresh token only.
      tokenData = await kiroService.validateImportToken(refreshToken);
    }

    // Extract email from JWT if available
    const email = imported.email || kiroService.extractEmailFromJWT(tokenData.accessToken);

    // Save to database
    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: getExpiresAt({
        expiresAt: tokenRefreshed ? null : imported.expiresAt,
        expiresIn: tokenData.expiresIn || imported.expiresIn,
      }),
      email: email || null,
      providerSpecificData: {
        ...durablePsd,
        profileArn: tokenData.profileArn || imported.profileArn,
        authMethod: tokenData.authMethod || durablePsd.authMethod,
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
