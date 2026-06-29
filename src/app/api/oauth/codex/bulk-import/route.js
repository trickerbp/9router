import { NextResponse } from "next/server";
import { createProviderConnection } from "@/lib/localDb";
import { extractCodexAccountInfo } from "@/lib/oauth/providers";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${error.message}` },
      { status: 400 },
    );
  }

  let accounts;
  if (Array.isArray(body)) {
    accounts = body;
  } else if (body && typeof body === "object" && Array.isArray(body.accounts)) {
    accounts = body.accounts;
  } else if (body && typeof body === "object") {
    accounts = [body];
  } else {
    accounts = null;
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json({ error: "No accounts provided" }, { status: 400 });
  }

  const results = [];
  let success = 0;
  let failed = 0;

  for (let index = 0; index < accounts.length; index += 1) {
    const raw = accounts[index];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }

      const {
        id: _id,
        provider: _provider,
        authType: _authType,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...item
      } = raw;

      if (!item.accessToken || typeof item.accessToken !== "string") {
        throw new Error("Missing accessToken");
      }

      const providerSpecificData = item.providerSpecificData || {};
      const needsEmail = !item.email;
      const needsAccountId = !providerSpecificData.chatgptAccountId;
      const needsPlanType = !providerSpecificData.chatgptPlanType;

      if (needsEmail || needsAccountId || needsPlanType) {
        const info = extractCodexAccountInfo(item.idToken || item.accessToken) || {};
        if (needsEmail && info.email) item.email = info.email;
        if (needsAccountId && info.chatgptAccountId) {
          providerSpecificData.chatgptAccountId = info.chatgptAccountId;
        }
        if (needsPlanType && info.chatgptPlanType) {
          providerSpecificData.chatgptPlanType = info.chatgptPlanType;
        }
      }

      if (Object.keys(providerSpecificData).length > 0) {
        item.providerSpecificData = providerSpecificData;
      }

      if (!item.expiresAt && typeof item.expiresIn === "number" && item.expiresIn > 0) {
        item.expiresAt = new Date(Date.now() + item.expiresIn * 1000).toISOString();
      }

      if (item.testStatus === undefined) item.testStatus = "active";
      if (item.isActive === undefined) item.isActive = true;
      if (!item.lastRefreshAt) item.lastRefreshAt = new Date().toISOString();

      const created = await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        ...item,
      });

      results.push({ index, ok: true, id: created.id });
      success += 1;
    } catch (error) {
      results.push({ index, ok: false, error: error.message || "Unknown error" });
      failed += 1;
    }
  }

  return NextResponse.json({ success, failed, results });
}
