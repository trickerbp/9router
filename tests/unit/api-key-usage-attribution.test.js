import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("../../src/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  (await getAdapter()).close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API-key usage attribution", () => {
  it("keeps same-prefix keys separate for every stats period", async () => {
    const keyA = await db.createApiKey("HTung", "machine-shared-prefix");
    const keyB = await db.createApiKey("HHai", "machine-shared-prefix");
    expect(keyA.key.slice(0, 8)).toBe(keyB.key.slice(0, 8));

    const timestamp = new Date().toISOString();
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      apiKey: keyA.key,
      tokens: { prompt_tokens: 10, completion_tokens: 1 },
      timestamp,
    });
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      apiKey: keyB.key,
      tokens: { prompt_tokens: 20, completion_tokens: 2 },
      timestamp,
    });

    for (const period of ["today", "24h", "7d", "all"]) {
      const stats = await db.getUsageStats(period);
      const rows = Object.values(stats.byApiKey).filter((row) => row.keyName === "HTung" || row.keyName === "HHai");
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.keyName === "HTung").requests).toBe(1);
      expect(rows.find((row) => row.keyName === "HHai").requests).toBe(1);
      expect(Object.keys(stats.byApiKey).some((key) => key.includes(keyA.key) || key.includes(keyB.key))).toBe(false);
    }
  });
});
