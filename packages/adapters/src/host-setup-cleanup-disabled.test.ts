import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHostComputerServer } from "./host-computer-server.js";
import { nativeSetupScopeKey, revokeNativeSetupScopes } from "./native-setup-transport.js";

describe("native setup cleanup while host execution is disabled", () => {
  const token = "bc".repeat(32);
  let root: string;
  let host: Awaited<ReturnType<typeof startHostComputerServer>>;
  let url: string;
  const request = (input: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/computer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-disabled-setup-"));
    host = await startHostComputerServer({
      root,
      token,
      hostname: "127.0.0.1",
      writeScopeRoot: path.join(root, "write-scopes"),
    });
    url = `http://127.0.0.1:${host.port}`;
  });
  afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "confirms deletion cleanup with prior execution consent %s",
    async (previouslyEnabled) => {
      if (previouslyEnabled) {
        host.setEnabled(true);
        host.setEnabled(false);
      }
      // This is the production Space/account cleanup transport, including its acknowledgement check.
      await revokeNativeSetupScopes(
        {
          prisma: {
            registeredHost: { findMany: vi.fn(async () => []) },
          } as unknown as PrismaClient,
          secrets: {} as SecretStore,
          hostComputerUrl: url,
          hostComputerToken: token,
        },
        [{ spaceId: "deleted-space", userId: "deleted-owner" }],
      );
      const scope = nativeSetupScopeKey("deleted-space", "deleted-owner", null);
      expect(
        JSON.parse(
          await readFile(
            path.join(root, "native-setup", "revoked-scopes", `${scope}.json`),
            "utf8",
          ),
        ),
      ).toEqual({ revoked: true });
      const registrationId = "deleted-host";
      const response = await request({
        method: "nativeSetupRevoke",
        botId: "setup",
        registrationId,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"revoked":true');
      const registration = createHash("sha256").update(registrationId).digest("hex");
      expect(
        JSON.parse(
          await readFile(
            path.join(root, "native-setup", "revoked", `${registration}.json`),
            "utf8",
          ),
        ),
      ).toEqual({ revoked: true });
      expect(host.isEnabled()).toBe(false);
    },
  );

  it("authenticates cleanup and rejects browser origins before parsing or writing", async () => {
    const input = { method: "nativeSetupScopeRevoke", botId: "setup", scopeKey: "a".repeat(64) };
    expect((await request(input, { authorization: "Bearer invalid" })).status).toBe(401);
    expect((await request(input, { origin: "https://browser.example.test" })).status).toBe(401);
    expect(await readdir(root)).not.toContain("native-setup");
  });

  it("keeps setup, reads, execution and other lifecycle methods blocked", async () => {
    for (const input of [
      { method: "environment", botId: "bot" },
      { method: "provision", botId: "bot" },
      {
        method: "execute",
        botId: "bot",
        command: { argv: [process.execPath, "-e", "process.exit(1)"] },
      },
      { method: "readFile", botId: "bot", path: "file" },
      { method: "stop", botId: "bot" },
      { method: "cancelRunWork", botId: "bot", targetRunId: "run" },
      { method: "codexStatus", botId: "bot" },
      ...["status", "login", "install", "cancel"].map((action) => ({
        method: "nativeSetup",
        botId: "setup",
        scopeKey: "a".repeat(64),
        registrationId: null,
        kind: "codex",
        action,
      })),
    ])
      expect((await request(input)).status).toBe(403);
    expect(
      (
        await request({
          method: "nativeSetupScopeRevoke",
          botId: "setup",
          scopeKey: "a".repeat(64),
          command: ["injected"],
        })
      ).status,
    ).toBe(400);
    expect(await readdir(root)).not.toContain("native-setup");
  });
});
