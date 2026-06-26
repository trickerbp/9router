import { NextResponse } from "next/server";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * GET /api/oauth/kiro/auto-import
 * Auto-detect and extract Kiro refresh token from AWS SSO cache
 */
export async function GET() {
  try {
    const cachePath = join(homedir(), ".aws/sso/cache");

    // Try to read cache directory
    let files;
    try {
      files = await readdir(cachePath);
    } catch (error) {
      return NextResponse.json({
        found: false,
        error: "AWS SSO cache not found. Please login to Kiro IDE first.",
      });
    }

    // Look for kiro-auth-token.json or any .json file with refreshToken
    let refreshToken = null;
    let foundFile = null;
    let durable = null;

    // Build a durable import payload from a parsed kiro-auth-token.json that
    // carries External IdP (Microsoft 365 / Entra) metadata. Returns null when
    // the file is not an external_idp credential.
    const buildExternalIdpDurable = (data) => {
      const isExternalIdp =
        data?.authMethod === "external_idp" ||
        data?.provider === "ExternalIdp" ||
        (!!data?.tokenEndpoint && !!data?.clientId && !data?.clientSecret);
      if (!isExternalIdp || !data?.refreshToken) return null;
      return {
        refreshToken: data.refreshToken,
        accessToken: data.accessToken || null,
        authMethod: "external_idp",
        clientId: data.clientId || null,
        tokenEndpoint: data.tokenEndpoint || null,
        issuerUrl: data.issuerUrl || null,
        scopes: data.scopes || null,
        expiresAt: data.expiresAt || null,
        provider: "External IdP",
      };
    };

    // First try kiro-auth-token.json
    const kiroTokenFile = "kiro-auth-token.json";
    if (files.includes(kiroTokenFile)) {
      try {
        const content = await readFile(join(cachePath, kiroTokenFile), "utf-8");
        const data = JSON.parse(content);
        const externalIdpDurable = buildExternalIdpDurable(data);
        if (externalIdpDurable) {
          durable = externalIdpDurable;
          refreshToken = data.refreshToken;
          foundFile = kiroTokenFile;
        } else if (data.refreshToken && data.refreshToken.startsWith("aorAAAAAG")) {
          refreshToken = data.refreshToken;
          foundFile = kiroTokenFile;
        }
      } catch (error) {
        // Continue to search other files
      }
    }

    // If not found, search all .json files
    if (!refreshToken) {
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        try {
          const content = await readFile(join(cachePath, file), "utf-8");
          const data = JSON.parse(content);

          const externalIdpDurable = buildExternalIdpDurable(data);
          if (externalIdpDurable) {
            durable = externalIdpDurable;
            refreshToken = data.refreshToken;
            foundFile = file;
            break;
          }

          // Look for Kiro social refresh token (starts with aorAAAAAG)
          if (data.refreshToken && data.refreshToken.startsWith("aorAAAAAG")) {
            refreshToken = data.refreshToken;
            foundFile = file;
            break;
          }
        } catch (error) {
          // Skip invalid JSON files
          continue;
        }
      }
    }

    if (!refreshToken) {
      return NextResponse.json({
        found: false,
        error: "Kiro token not found in AWS SSO cache. Please login to Kiro IDE first.",
      });
    }

    return NextResponse.json({
      found: true,
      refreshToken,
      // For External IdP credentials the bare refresh token is not enough to
      // import; the durable payload carries the IdP token endpoint, client id
      // and scopes the import + refresh paths require.
      durable: durable || null,
      source: foundFile,
    });
  } catch (error) {
    console.log("Kiro auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 }
    );
  }
}
