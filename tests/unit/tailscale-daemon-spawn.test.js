import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execSync: vi.fn(() => { throw new Error("not running"); }),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  exec: mocks.exec,
  execSync: mocks.execSync,
  spawn: mocks.spawn,
}));

vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  const linuxOs = { ...actual, platform: () => "linux" };
  return { ...linuxOs, default: linuxOs };
});

const previousDataDir = process.env.DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), "9router-tailscale-spawn-"));
process.env.DATA_DIR = testDataDir;

const { startDaemonWithPassword } = await import("../../src/lib/tunnel/tailscale/tailscale.js");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

describe("Tailscale daemon startup", () => {
  it("rejects a missing tailscaled executable instead of emitting an uncaught error", async () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        const error = Object.assign(new Error("spawn tailscaled ENOENT"), { code: "ENOENT" });
        child.emit("error", error);
      });
      return child;
    });

    await expect(startDaemonWithPassword("")).rejects.toMatchObject({ code: "ENOENT" });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "tailscaled",
      expect.arrayContaining(["--tun=userspace-networking"]),
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(child.unref).not.toHaveBeenCalled();
  });
});
