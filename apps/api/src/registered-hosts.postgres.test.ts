import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunSandbox,
  EncryptedSecretStore,
  FakeSandboxProvider,
  HostComputerSandbox,
  reconcileRegisteredHostRevocations,
} from "@rakazo/adapters";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { startHostComputerServer } from "../../../packages/adapters/src/host-computer-server.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";
import { createConversationTask } from "./conversation-tasks.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
it.skipIf(!databaseUrl)(
  "scopes host registration, encrypted credentials, placement, revocation and immutable identity",
  async () => {
    let unrelatedProcess: ReturnType<typeof spawn> | undefined;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-host-registry-"));
    const localHost = await startHostComputerServer({
      root: join(dataDir, "host"),
      writeScopeRoot: join(await realpath(dataDir), "write-scopes"),
      token: "ab".repeat(32),
    });
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      encryptionKey: "registered-host-test-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: "http://127.0.0.1:5173",
      authUrl: "http://127.0.0.1:5173",
    });
    async function signup() {
      const response = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `${randomUUID()}@example.test`,
          password: "test-password-123",
          name: "Host tester",
        }),
      });
      expect(response.status).toBeLessThan(400);
      return sessionCookieHeader(response);
    }
    async function rpc(cookie: string, method: string, input = {}) {
      const response = await handles.app.request(`/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ json: input }),
      });
      return { status: response.status, body: await response.json() };
    }
    try {
      const owner = await signup();
      const stranger = await signup();
      const token = "ab".repeat(32);
      const registration = {
        name: "Build host",
        endpoint: `http://127.0.0.1:${localHost.port}`,
        token,
        trusted: true,
      };
      expect((await rpc(owner, "hosts/register", { ...registration, trusted: false })).status).toBe(
        400,
      );
      const created = await rpc(owner, "hosts/register", registration);
      expect(created.status).toBe(200);
      const host = created.body.json;
      expect(JSON.stringify(created.body)).not.toContain(token);
      expect(host).not.toHaveProperty("ciphertext");
      const row = await runAsSystem("registered host test", () =>
        handles.prisma.registeredHost.findUniqueOrThrow({ where: { id: host.id } }),
      );
      expect(row.ciphertext).not.toContain(token);
      expect(row.endpoint).toBe(registration.endpoint);
      expect(
        await runAsTenant({ spaceId: row.spaceId, userId: "another-owner" }, () =>
          handles.prisma.registeredHost.findMany(),
        ),
      ).toEqual([]);
      await expect(
        runAsTenant({ spaceId: row.spaceId, userId: row.userId }, () =>
          handles.prisma.registeredHost.update({
            where: { id: host.id },
            data: { ciphertext: "replacement-ciphertext" },
          }),
        ),
      ).rejects.toThrow();
      expect((await rpc(owner, "hosts/check", { hostId: host.id })).body.json.healthStatus).toBe(
        "unavailable",
      );
      localHost.setEnabled(true);
      expect((await rpc(owner, "hosts/check", { hostId: host.id })).body.json.healthStatus).toBe(
        "available",
      );
      expect((await rpc(stranger, "hosts/list")).body.json).toEqual([]);
      expect((await rpc(stranger, "hosts/revoke", { hostId: host.id })).status).toBe(404);
      const bot = await rpc(owner, "bots/create", {
        name: "Remote helper",
        runtimeKind: "pi",
        executionTarget: "host",
        registeredHostId: host.id,
        runtimePermission: "workspace",
        projectPath: null,
      });
      expect(bot.status).toBe(200);
      expect(bot.body.json.registeredHostId).toBe(host.id);
      const placement = await runAsSystem("registered host test", () =>
        handles.prisma.bot.findUniqueOrThrow({
          where: { id: bot.body.json.id },
          include: { computer: true },
        }),
      );
      expect(placement.computer?.registeredHostId).toBe(host.id);
      const secrets = new EncryptedSecretStore("registered-host-test-encryption-key");
      const sandbox = createRunSandbox("fake", { prisma: handles.prisma, secrets });
      const transportContext = {
        spaceId: row.spaceId,
        userId: row.userId,
        botId: placement.id,
        runId: "registered-host-probe",
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(5000),
      };
      const computer = await runAsTenant(row, () =>
        sandbox.provision(
          {
            botId: placement.computer!.homeKey,
            homePath: "/unused",
            executionTarget: "host",
            registeredHostId: host.id,
          },
          transportContext,
        ),
      );
      let output = "";
      await runAsTenant(row, async () => {
        for await (const event of sandbox.execute(
          computer,
          { argv: [process.execPath, "-e", "process.stdout.write('registered-host')"] },
          transportContext,
        )) {
          if (event.type === "stdout") output += event.data;
        }
      });
      expect(output).toBe("registered-host");
      await secrets.close();
      const foreign = await rpc(stranger, "bots/create", {
        name: "Foreign",
        executionTarget: "host",
        registeredHostId: host.id,
      });
      expect(foreign.status).toBe(400);
      await expect(
        runAsSystem("registered host identity test", () =>
          handles.prisma.registeredHost.update({
            where: { id: host.id },
            data: { endpoint: "https://replacement.example.test" },
          }),
        ),
      ).rejects.toThrow();
      const actor = {
        spaceId: row.spaceId,
        userId: row.userId,
        email: "",
        isDeploymentOwner: false,
      };
      const sourceThread = await runAsSystem("registered host revocation test", () =>
        handles.prisma.thread.findFirstOrThrow({ where: { botId: placement.id } }),
      );
      const task = await runAsTenant(actor, () =>
        createConversationTask(handles.prisma, actor, {
          botId: placement.id,
          text: "Owned revocation fixture",
          clientNonce: randomUUID(),
          originThreadId: sourceThread.id,
        }),
      );
      const otherBot = await rpc(owner, "bots/create", { name: "Unaffected helper" });
      expect(otherBot.status).toBe(200);
      const queued = await runAsSystem("registered host group queue fixture", async () => {
        const message = await handles.prisma.message.create({
          data: {
            threadId: task.task.threadId,
            seq: 100,
            role: "user",
            blocks: [{ type: "text", text: "Queued input" }],
            searchTokens: [],
          },
        });
        return Promise.all(
          [placement.id, otherBot.body.json.id].map((botId) =>
            handles.prisma.steeringMessage.create({
              data: { messageId: message.id, botId, userId: row.userId },
            }),
          ),
        );
      });
      const nativeTarget = `owned-process-${randomUUID()}`;
      await runAsSystem("registered host revocation test", () =>
        handles.prisma.run.update({
          where: { id: task.task.runId },
          data: {
            status: "running",
            nativeHostId: host.id,
            nativeExecutionRunId: nativeTarget,
            nativeComputerId: placement.computer!.id,
            nativeComputerKey: placement.computer!.homeKey,
          },
        }),
      );
      await runAsSystem("registered host revocation test", () =>
        handles.prisma.nativeExecutionReservation.create({
          data: {
            runId: task.task.runId,
            hostKey: `registered:${host.id}`,
            writeRoot: null,
            ownerFence: 1,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      );
      const raw = new HostComputerSandbox(registration.endpoint, token);
      let ownedEnded = false;
      let siblingEnded = false;
      let ownedReady = false;
      let siblingReady = false;
      const hold = async (runId: string, ready: () => void) => {
        for await (const event of raw.execute(
          computer,
          {
            argv: [
              process.execPath,
              "-e",
              "process.stdout.write('ready');setTimeout(()=>{},60000)",
            ],
          },
          { ...transportContext, runId, signal: AbortSignal.timeout(30_000) },
        )) {
          if (event.type === "stdout" && event.data.includes("ready")) ready();
        }
      };
      const owned = hold(nativeTarget, () => {
        ownedReady = true;
      })
        .finally(() => {
          ownedEnded = true;
        })
        .catch(() => undefined);
      unrelatedProcess = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready');setTimeout(()=>{},60000)"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      unrelatedProcess.stdout!.once("data", () => {
        siblingReady = true;
      });
      unrelatedProcess.once("exit", () => {
        siblingEnded = true;
      });
      await vi.waitFor(() => expect(ownedReady && siblingReady).toBe(true));
      const originalFetch = globalThis.fetch;
      let rejectedOnce = false;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (
          String(input) === `${registration.endpoint}/computer` &&
          body.method === "cancelRunWork" &&
          !rejectedOnce
        ) {
          rejectedOnce = true;
          return new Response("Temporary unavailable", { status: 503 });
        }
        return originalFetch(input, init);
      });
      const revoked = await rpc(owner, "hosts/revoke", { hostId: host.id });
      expect(revoked.body.json.healthStatus).toBe("revoked");
      expect(revoked.body.json.revocationPending).toBe(true);
      expect(ownedEnded).toBe(false);
      expect(siblingEnded).toBe(false);
      const queuedAfter = await runAsSystem("registered host group queue assertion", () =>
        handles.prisma.steeringMessage.findMany({
          where: { id: { in: queued.map((item) => item.id) } },
        }),
      );
      expect(queuedAfter.find((item) => item.botId === placement.id)?.cancelledAt).not.toBeNull();
      expect(
        queuedAfter.find((item) => item.botId === otherBot.body.json.id)?.cancelledAt,
      ).toBeNull();
      await expect(
        runAsSystem("pending host deletion test", () =>
          handles.prisma.registeredHost.delete({ where: { id: host.id } }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await runAsSystem("registered host revocation test", () =>
            handles.prisma.run.findUniqueOrThrow({ where: { id: task.task.runId } }),
          )
        ).status,
      ).toBe("cancelled");
      expect(
        await runAsSystem("registered host revocation test", () =>
          handles.prisma.nativeExecutionReservation.count({ where: { runId: task.task.runId } }),
        ),
      ).toBe(1);
      await runAsSystem("registered host worker retry test", () =>
        reconcileRegisteredHostRevocations({
          prisma: handles.prisma,
          secrets: new EncryptedSecretStore("registered-host-test-encryption-key"),
        }),
      );
      fetchSpy.mockRestore();
      const retried = await runAsSystem("registered host revocation test", () =>
        handles.prisma.registeredHost.findUniqueOrThrow({ where: { id: host.id } }),
      );
      expect(retried.revocationPending).toBe(false);
      expect(
        await runAsSystem("registered host revocation test", () =>
          handles.prisma.nativeExecutionReservation.count({ where: { runId: task.task.runId } }),
        ),
      ).toBe(0);
      await vi.waitFor(() => expect(ownedEnded).toBe(true));
      expect(siblingEnded).toBe(false);
      const cleanup = await runAsSystem("registered host revocation test", () =>
        handles.prisma.registeredHostCleanup.findFirstOrThrow({
          where: { hostId: host.id, runId: task.task.runId },
        }),
      );
      expect(cleanup.targetRunId).toBe(nativeTarget);
      expect(cleanup.completedAt).not.toBeNull();
      await owned;
      expect((await rpc(owner, "hosts/revoke", { hostId: host.id })).status).toBe(200);
      expect(
        (
          await rpc(owner, "bots/create", {
            name: "Revoked",
            executionTarget: "host",
            registeredHostId: host.id,
          })
        ).status,
      ).toBe(400);
      await runAsTenant(actor, async () => {
        await expect(
          sandbox.prepare(computer, { ...transportContext, signal: new AbortController().signal }),
        ).rejects.toThrow("revoked");
        await sandbox.cancelRunWork!(computer, placement.computer!.id, nativeTarget, {
          ...transportContext,
          runId: task.task.runId,
          requireRunCleanup: true,
          signal: new AbortController().signal,
        });
        await expect(
          sandbox.cancelRunWork!(computer, placement.computer!.id, "unrelated-native-id", {
            ...transportContext,
            runId: task.task.runId,
            requireRunCleanup: true,
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("revoked");
        await sandbox.destroy(computer, {
          ...transportContext,
          signal: new AbortController().signal,
        });
      });
      await expect(
        runAsSystem("registered host revocation test", () =>
          handles.prisma.registeredHost.update({
            where: { id: host.id },
            data: { revokedAt: null },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        runAsSystem("completed cleanup cascade test", () =>
          handles.prisma.$transaction(async (tx) => {
            await tx.space.delete({ where: { id: row.spaceId } });
            expect(await tx.registeredHostCleanup.count({ where: { hostId: host.id } })).toBe(0);
            throw new Error("rollback checked cascade");
          }),
        ),
      ).rejects.toThrow("rollback checked cascade");
    } finally {
      vi.restoreAllMocks();
      unrelatedProcess?.kill("SIGTERM");
      await localHost.close();
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
