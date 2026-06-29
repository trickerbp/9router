import { NextResponse } from "next/server";
import { createProviderConnection } from "@/lib/localDb";
import { KiroService } from "@/lib/oauth/services/kiro";

export async function POST(request) {
  try {
    const { apiKey, region } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const kiroService = new KiroService();
    const credential = await kiroService.validateApiKey(apiKey, region || "us-east-1");
    const email = kiroService.extractEmailFromJWT(credential.accessToken);

    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "api_key",
      accessToken: credential.accessToken,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: credential.profileArn,
        region: credential.region,
        authMethod: "api_key",
        provider: "API Key",
      },
      testStatus: "active",
      isActive: true,
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
    console.log("Kiro API key import error:", error);
    return NextResponse.json({ error: "API key validation failed" }, { status: 500 });
  }
}
