import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppHandles } from "@rakazo/api/app";
import {
  asSystem,
  createThreadEvents,
  loadRunTurnCheckpoint,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type * as CodexProcess from "../../adapters/src/codex-app-server.js";
import type { CodexClientFactory } from "../../adapters/src/codex-app-server.js";
import { HostComputerSandbox } from "../../adapters/src/host-computer-sandbox.js";
import { startHostComputerServer } from "../../adapters/src/host-computer-server.js";
import { nativeIntroExecutionId } from "../../adapters/src/native-context.js";
import { EncryptedSecretStore } from "../../adapters/src/secrets.js";

// Only the external provider process is fake. Database answers, executor,
// application effect gates, runtime, authenticated HTTP and host broker are real.
const provider = vi.hoisted(() => ({ factory: vi.fn<CodexClientFactory>() }));
vi.mock("../../adapters/src/codex-app-server.js", async (original) => ({
  ...(await original<typeof CodexProcess>()),
  createCodexClientFactory: () => provider.factory,
}));

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!available)("native creation answer continuation (PostgreSQL + host)", () => {
  it.each(["normal", "lost-retirement-ack"])(
    "retires the restricted intro and completes the actual answer (%s)",
    async (scenario) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-native-onboarding-")));
      const projectPath = path.join(root, "project");
      await mkdir(projectPath);
      const token = "ef".repeat(32);
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const replies: unknown[] = [];
      let sessionCount = 0;
      let turnCount = 0;
      provider.factory.mockReset().mockImplementation((emit) => {
        let session = "";
        let turn = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        return {
          notify() {},
          close() {
            clearTimeout(timer);
          },
          reply(_id, result) {
            replies.push(result);
            timer = setTimeout(
              () =>
                emit({
                  method: "turn/completed",
                  params: {
                    threadId: session,
                    turn: { id: turn, status: "completed" },
                  },
                }),
              5,
            );
          },
          async request(method, input) {
            const params = (input ?? {}) as Record<string, unknown>;
            calls.push({ method, params });
            if (method === "config/read") return { config: {} };
            if (method === "account/read") return { requiresOpenaiAuth: false };
            if (method === "thread/start") {
              session = `session-${++sessionCount}`;
              return { thread: { id: session } };
            }
            if (method === "thread/backgroundTerminals/list") return { data: [] };
            if (method === "turn/start") {
              turn = `turn-${++turnCount}`;
              const first = turnCount === 1;
              timer = setTimeout(
                () =>
                  emit(
                    first
                      ? {
                          id: "intro-question",
                          method: "item/tool/requestUserInput",
                          params: {
                            threadId: session,
                            turnId: turn,
                            questions: [{ id: "purpose", question: "What should I do?" }],
                          },
                        }
                      : {
                          id: "write-rpc",
                          method: "item/tool/call",
                          params: {
                            threadId: session,
                            turnId: turn,
                            callId: "write-answer",
                            tool: "write_file",
                            arguments: { path: "notes/answer.txt", content: "completed user task" },
                          },
                        },
                  ),
                5,
              );
              return { turn: { id: turn } };
            }
            if (method === "turn/interrupt") {
              emit({
                method: "turn/completed",
                params: {
                  threadId: session,
                  turn: { id: turn, status: "interrupted" },
                },
              });
            }
            return {};
          },
        };
      });
      const host = await startHostComputerServer({
        root,
        token,
        hostname: "127.0.0.1",
        writeScopeRoot: path.join(root, "write-scopes"),
      });
      host.setEnabled(true);
      const url = `http://127.0.0.1:${host.port}`;
      vi.stubEnv("SANDBOX_HOST_URL", url);
      vi.stubEnv("SANDBOX_HOST_TOKEN", token);
      let handles: AppHandles | undefined;
      let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>> | undefined;
      try {
        const { createApp } = await import("@rakazo/api/app");
        const sandbox = new HostComputerSandbox(url, token);
        handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          dataDir: path.join(root, "app"),
          sandboxProvider: "fake",
          sandbox,
          agentRuntime: "scripted",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          encryptionKey: "native-onboarding-offline-test-key",
        });
        const db = asSystem(handles.prisma);
        identity = await runAsSystem("native onboarding fixture", () =>
          provisionMessagingIdentity(
            handles!.prisma,
            { provider: "email", address: `native-intro-${randomUUID()}@example.test` },
            { signupsEnabled: true, signupAllowlist: undefined },
          ),
        );
        const { userId, spaceId, botId, threadId } = identity;
        const hostId = randomUUID();
        const storedToken = await new EncryptedSecretStore(
          "native-onboarding-offline-test-key",
        ).put(
          token,
          {
            operationId: "fixture",
            traceId: "fixture",
            userId,
            spaceId,
            signal: AbortSignal.timeout(5000),
          },
          { recordId: hostId },
        );
        await db.registeredHost.create({
          data: {
            id: hostId,
            userId,
            spaceId,
            name: "Fixture",
            endpoint: url,
            ciphertext: storedToken.ciphertext,
          },
        });
        const computer = await db.computer.create({
          data: {
            userId,
            spaceId,
            scopeKey: randomUUID(),
            homeKey: randomUUID(),
            kind: "desktop",
            executionTarget: "host",
            registeredHostId: hostId,
          },
        });
        await db.bot.update({
          where: { id: botId },
          data: {
            computerId: computer.id,
            runtimeKind: "codex",
            executionTarget: "host",
            projectPath,
            runtimePermission: "workspace",
            notifyOnFinish: false,
            registeredHostId: hostId,
          },
        });
        await db.userActionApprovalRule.create({
          data: {
            userId,
            effect: "allow",
            matchKind: "tool",
            matchValue: "write_file",
          },
        });
        const task = await db.task.create({
          data: { userId, spaceId, botId, threadId, prompt: "Ask what to do.", status: "queued" },
        });
        const run = await db.run.create({
          data: {
            userId,
            spaceId,
            botId,
            threadId,
            taskId: task.id,
            trigger: "created",
            status: "queued",
          },
        });
        await runAsSystem("native intro", () =>
          handles!.executor.continueRun(run.id, "intro-worker"),
        );
        expect(await db.run.findUnique({ where: { id: run.id } })).toMatchObject({
          status: "waiting_input",
          trigger: "created",
          nativeExecutionRunId: run.id,
        });
        expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
        expect(
          (
            calls.find((call) => call.method === "thread/start")!.params.dynamicTools as Array<{
              name: string;
            }>
          ).map((tool) => tool.name),
        ).toEqual(["update_bot"]);
        const message = await db.message.findFirstOrThrow({
          where: { runId: run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(message.blocks).toEqual([
          expect.objectContaining({
            kind: "ask",
            status: "pending",
            nativeInteractionId: expect.any(String),
          }),
        ]);
        const checkpoint = JSON.parse(
          (await runAsSystem("load native intro checkpoint", () =>
            loadRunTurnCheckpoint(handles!.prisma, run),
          ))!,
        );
        expect(message.blocks).toEqual([
          expect.objectContaining({ nativeInteractionId: checkpoint.approvalId }),
        ]);
        const events = createThreadEvents(handles.prisma);
        const answered = await runAsSystem("native intro answer", () =>
          events.answerRunInput({
            runId: run.id,
            spaceId,
            threadId,
            messageId: message.id,
            answeredByUserId: userId,
            answer: "Write completed user task to notes/answer.txt.",
            clientNonce: randomUUID(),
          }),
        );
        expect(answered).toBeTruthy();
        let loseAck = scenario === "lost-retirement-ack";
        const originalFetch = globalThis.fetch;
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const response = await originalFetch(input, init);
          if (
            loseAck &&
            typeof init?.body === "string" &&
            JSON.parse(init.body).method === "codexRetire"
          ) {
            // The real host finished strict cleanup, but the worker never receives
            // its receipt. Recovery must retain the answer and repeat only retirement.
            await response.text();
            loseAck = false;
            throw new Error("Lost native retirement acknowledgement");
          }
          return response;
        });
        try {
          const continuation = runAsSystem("native answer continuation", () =>
            handles!.executor.continueRun(run.id, "answer-worker"),
          );
          if (scenario === "lost-retirement-ack") {
            await expect(continuation).rejects.toThrow("Run setup failed; retrying");
            expect(await db.run.findUnique({ where: { id: run.id } })).toMatchObject({
              status: "queued",
              nativeExecutionRunId: run.id,
            });
            const retained = await runAsSystem("load stopping checkpoint", () =>
              loadRunTurnCheckpoint(handles!.prisma, run),
            );
            expect(JSON.parse(retained!)).toMatchObject({
              introHandover: {
                phase: "stopping",
                answer: "Write completed user task to notes/answer.txt.",
              },
            });
            expect(turnCount).toBe(1);
            await db.run.update({ where: { id: run.id }, data: { wakeAt: null } });
            await runAsSystem("native handover recovery", () =>
              handles!.executor.continueRun(run.id, "recovery-worker"),
            );
          } else await continuation;
        } finally {
          fetchSpy.mockRestore();
        }
        const finished = await db.run.findUniqueOrThrow({ where: { id: run.id } });
        expect(finished).toMatchObject({
          status: "completed",
          trigger: "user",
          nativeExecutionRunId: nativeIntroExecutionId(run.id),
          error: null,
        });
        expect(turnCount).toBe(2);
        expect(sessionCount).toBe(2);
        const starts = calls.filter((call) => call.method === "thread/start");
        expect(
          (starts[1]!.params.dynamicTools as Array<{ name: string }>).some(
            (tool) => tool.name === "write_file",
          ),
        ).toBe(true);
        const interrupt = calls.findIndex((call) => call.method === "turn/interrupt");
        expect(interrupt).toBeGreaterThan(0);
        expect(interrupt).toBeLessThan(
          calls.findLastIndex((call) => call.method === "thread/start"),
        );
        expect(
          JSON.stringify(calls.findLast((call) => call.method === "turn/start")!.params.input),
        ).toContain("Write completed user task to notes/answer.txt.");
        expect(replies).toEqual([expect.objectContaining({ success: true })]);
        const result = await sandbox.readFile(
          {
            id: computer.id,
            botId: computer.homeKey,
            kind: "desktop",
            providerRef: `host:${computer.homeKey}`,
          },
          `bots/${botId}/notes/answer.txt`,
          {
            operationId: "read-result",
            traceId: "read-result",
            userId,
            spaceId,
            signal: AbortSignal.timeout(5000),
          },
        );
        expect(new TextDecoder().decode(result)).toBe("completed user task");
        const effects = await db.externalEffect.findMany({
          where: { runId: run.id, kind: "write_file" },
        });
        expect(effects).toHaveLength(1);
        // Re-delivering the job cannot restart the finished physical execution.
        await runAsSystem("native completed replay", () =>
          handles!.executor.continueRun(run.id, "replay-worker"),
        );
        expect(turnCount).toBe(2);
      } finally {
        if (handles && identity) {
          const db = asSystem(handles.prisma);
          const fixtureRuns = await db.run.findMany({
            where: { botId: identity.botId },
            select: { id: true },
          });
          await db.nativeExecutionReservation.deleteMany({
            where: { runId: { in: fixtureRuns.map((run) => run.id) } },
          });
          await db.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
          await db.organization.deleteMany({ where: { id: identity.spaceId } });
          await db.registeredHost.deleteMany({ where: { userId: identity.userId } });
          await db.user.deleteMany({ where: { id: identity.userId } });
        }
        await handles?.stop();
        await host.close();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
