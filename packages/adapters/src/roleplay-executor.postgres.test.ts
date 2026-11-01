import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { RoleplayRunRequest, RoleplayRuntime } from "./roleplay-runtime.js";
import type * as RunModel from "./run-model.js";

// Only external boundaries are fake: durable history, run leases, steering, and finalization are real.
vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  provisionComputer: async () => ({
    id: "test-docker-container",
    kind: "docker",
    executionTarget: "docker",
  }),
}));
vi.mock("./run-model.js", async (original) => ({
  ...(await original<typeof RunModel>()),
  resolveRunModel: async () => ({
    provider: "test-provider",
    id: "test-model",
    contextWindow: 16_384,
    maxTokens: 2048,
  }),
}));

import { createRunExecutor } from "./executor.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
describePostgres("dedicated roleplay execution (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const address = `+1557${String(Date.now()).slice(-7)}`;
  const owner = <T>(work: () => Promise<T>) => runAsTenant(actor, work);
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    const identity = await runAsSystem("roleplay executor fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    await prisma.user.update({ where: { id: identity.userId }, data: { roleplayEnabled: true } });
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "story@example.invalid",
      isDeploymentOwner: false,
    };
  });
  afterAll(async () => {
    if (actor) {
      const system = asSystem(prisma, "roleplay executor fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: actor.spaceId } });
      await system.user.deleteMany({ where: { id: actor.userId } });
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });

  it("finishes a slow turn then consumes queued input once with correct story chronology", async () => {
    const bot = await owner(() =>
      createRepos(prisma).createBot(actor, {
        name: "Aria",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        botKind: "roleplay",
        roleplayCharacter: parseRoleplayCharacterJson(
          JSON.stringify({
            name: "Aria",
            description: "A cartographer",
            first_mes: "The map unfolds.",
          }),
        ).character,
      }),
    );
    const events = createThreadEvents(prisma);
    const first = await owner(() =>
      events.sendUserMessage({
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: bot.threadId,
        botId: bot.id,
        blocks: [{ kind: "text", text: "I inspect the map." }],
        prompt: "I inspect the map.",
        trigger: "user",
        clientNonce: randomUUID(),
      }),
    );
    expect(first.runId).toBeTruthy();
    const requests: RoleplayRunRequest[] = [];
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: RoleplayRuntime = {
      abort: async () => undefined,
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          ready();
          await hold;
        }
        const text =
          requests.length === 1
            ? "Aria points to the hidden passage."
            : "Aria follows you into the passage.";
        yield { type: "text", text };
        yield { type: "done", text };
      },
    };
    const forbidden = vi.fn(() => {
      throw new Error("Agent capabilities must not be loaded");
    });
    const deps = {
      prisma,
      events,
      roleplayRuntime: runtime,
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
      sandbox: { describe: () => ({ id: "docker" }) },
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: forbidden },
      memory: { read: forbidden, write: forbidden },
      memoryProviders: { resolve: forbidden },
      connector: { discoverTools: forbidden },
      secretStore: { load: forbidden },
      web: {},
      mediaGeneration: {},
      browser: {},
    } as unknown as ExecutorDeps;
    const executor = createRunExecutor(deps);
    const firstWork = owner(() => executor.continueRun(first.runId!, "story-worker"));
    await started;
    const second = await owner(() =>
      events.sendUserMessage({
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: bot.threadId,
        botId: bot.id,
        blocks: [{ kind: "text", text: "I enter the passage." }],
        prompt: "I enter the passage.",
        trigger: "user",
        clientNonce: randomUUID(),
      }),
    );
    expect(second.runId).toBe(first.runId);
    expect(second.taskId).toBeNull();
    release();
    await firstWork;
    const continuation = await owner(() =>
      prisma.run.findFirstOrThrow({ where: { botId: bot.id, status: "queued" } }),
    );
    expect(continuation.trigger).toBe("follow_up");
    await owner(() => executor.continueRun(continuation.id, "replacement-story-worker"));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toBe("I enter the passage.");
    expect(requests[1]!.history.at(-1)!.content).toBe("Aria points to the hidden passage.");
    expect(requests[1]!.history.map((message) => message.content)).not.toContain(
      "I enter the passage.",
    );
    await owner(async () => {
      expect(await prisma.steeringMessage.count({ where: { botId: bot.id } })).toBe(0);
      expect(await prisma.run.count({ where: { botId: bot.id, status: "queued" } })).toBe(0);
      expect(await prisma.run.count({ where: { botId: bot.id, status: "completed" } })).toBe(2);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toMatchObject({
        threadId: bot.threadId,
        botId: bot.id,
        turnCount: 2,
        lastRunId: continuation.id,
      });
      expect(await prisma.memoryDocument.count({ where: { botId: bot.id } })).toBe(0);
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
});
