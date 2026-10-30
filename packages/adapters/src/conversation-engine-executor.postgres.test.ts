import { randomUUID } from "node:crypto";
import type { ConversationEngine, ConversationEngineEvent } from "@rakazo/adapter-kit";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type { Actor, Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  cancelRunsInTransaction,
  createDb,
  createRepos,
  createThreadEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import type * as RunModel from "./run-model.js";

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Local agent and roleplay machinery must not run");
  }),
);
vi.mock("./run-model.js", async (original) => ({
  ...(await original<typeof RunModel>()),
  resolveRunModel: forbidden,
}));

import { createRunExecutor } from "./executor.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
type EngineInput = Parameters<ConversationEngine["stream"]>[0];
const characterId = "cc0b7acf-d979-4e48-b027-26b04570ea57";
const final = (text: string): ConversationEngineEvent => ({
  type: "final",
  text,
  ghost: false,
  truncated: false,
});

describePostgres("external conversation engine execution (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const actors: Actor[] = [];
  const addresses: string[] = [];
  const owner = <T>(actor: Actor, work: () => Promise<T>) => runAsTenant(actor, work);
  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    for (let index = 0; index < 2; index++) {
      const address = `engine-executor-${randomUUID()}`;
      addresses.push(address);
      const identity = await runAsSystem("conversation engine executor fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider: "sendblue", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      actors.push({
        userId: identity.userId,
        spaceId: identity.spaceId,
        email: "engine@example.invalid",
        isDeploymentOwner: false,
      });
    }
  });
  afterAll(async () => {
    if (prisma) {
      const system = asSystem(prisma, "conversation engine executor fixture cleanup");
      // This fake has no remote persistence. Explicit teardown precedes deleting ownership rows.
      for (const actor of actors) {
        await system.companionTurn.deleteMany({ where: { spaceId: actor.spaceId } });
        await system.companionSession.deleteMany({ where: { spaceId: actor.spaceId } });
        await system.messagingIdentity.deleteMany({
          where: { provider: "sendblue", address: { in: addresses } },
        });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });

  const createBot = (actor = actors[0]!) =>
    owner(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Companion",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        botKind: "roleplay",
        conversationEngine: "eros",
        erosCharacterId: characterId,
      }),
    );
  const send = (bot: Bot, text: string, actor = actors[0]!) =>
    owner(actor, () =>
      createThreadEvents(prisma).sendUserMessage({
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: bot.threadId,
        botId: bot.id,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "user",
        clientNonce: randomUUID(),
      }),
    );
  function harness(
    stream: (input: EngineInput, signal?: AbortSignal) => AsyncIterable<ConversationEngineEvent>,
  ) {
    const requests: EngineInput[] = [];
    const provision = vi.fn(async () => ({ sessionId: randomUUID(), instanceId: randomUUID() }));
    const engine: ConversationEngine = {
      id: "eros",
      name: "Eros",
      characters: [{ id: characterId, name: "Companion" }],
      capabilities: { streaming: true, tools: false, cancel: false },
      provision,
      async *stream(input, signal) {
        requests.push({ ...input });
        yield* stream(input, signal);
      },
    };
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      roleplayEnabled: true,
      conversationEngines: new Map([["eros", engine]]),
      roleplayRuntime: { run: forbidden, abort: forbidden },
      contextStrategy: { build: forbidden },
      runtime: { describe: forbidden, run: forbidden },
      sandbox: { describe: forbidden, provision: forbidden, prepare: forbidden },
      memory: { read: forbidden, write: forbidden },
      memoryProviders: { resolve: forbidden },
      connector: { discoverTools: forbidden },
      secretStore: { load: forbidden },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
      web: {},
      mediaGeneration: {},
      browser: {},
    } as unknown as ExecutorDeps;
    return {
      requests,
      provision,
      executor: createRunExecutor(deps),
      restart: () => createRunExecutor(deps),
    };
  }
  async function assertCompleted(bot: Bot, runId: string, text: string, actor = actors[0]!) {
    await owner(actor, async () => {
      expect(await prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "completed",
      });
      expect(await prisma.message.findMany({ where: { runId, role: "bot" } })).toMatchObject([
        { blocks: [{ kind: "text", text }] },
      ]);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toBeNull();
      expect(await prisma.memoryDocument.count({ where: { botId: bot.id } })).toBe(0);
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).computerId).toBeNull();
    });
    expect(forbidden).not.toHaveBeenCalled();
  }

  it("dispatches before all local context, model, memory, tools, and computer work and commits encrypted state", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    await owner(actor, () =>
      prisma.bot.update({
        where: { id: bot.id },
        data: {
          conversationEngineSettings: {
            promptTraits: [{ tag: "curious", text: "Private character trait" }],
          },
        },
      }),
    );
    const h = harness(async function* () {
      yield { type: "text", text: "Draft" };
      yield final("Authoritative reply");
    });
    const run = await send(bot, "Only the current input");
    await owner(actor, () => h.executor.continueRun(run.runId!, "engine-worker"));
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      text: "Only the current input",
      settings: { promptTraits: [{ tag: "curious", text: "Private character trait" }] },
    });
    expect(h.requests[0]!.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.requests[0]!.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.provision).toHaveBeenCalledWith(
      { userId: h.requests[0]!.userId, characterId },
      expect.any(AbortSignal),
    );
    await assertCompleted(bot, run.runId!, "Authoritative reply");
    await owner(actor, async () => {
      const turn = await prisma.companionTurn.findUniqueOrThrow({ where: { runId: run.runId! } });
      expect(turn).toMatchObject({
        input: "Only the current input",
        response: "Authoritative reply",
        status: "completed",
      });
      const raw = await prisma.$queryRaw<
        Array<{ input: string; response: string; request: unknown }>
      >`SELECT input, response, request FROM companion_turns WHERE id=${turn.id}`;
      expect(raw[0]!.input).not.toContain("Only the current input");
      expect(raw[0]!.response).not.toContain("Authoritative reply");
      expect(JSON.stringify(raw[0]!.request)).not.toContain("Private character trait");
      const botRows = await prisma.$queryRaw<Array<{ settings: unknown }>>`
        SELECT "conversationEngineSettings" AS settings FROM bots WHERE id=${bot.id}`;
      expect(JSON.stringify(botRows[0]!.settings)).not.toContain("Private character trait");
      expect(
        (await prisma.companionSession.findUniqueOrThrow({ where: { id: turn.sessionId } }))
          .leaseRunId,
      ).toBeNull();
    });
  });

  it("recovers a remotely completed turn after worker restart without generation or duplicate delivery", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    const run = await send(bot, "Recover this input");
    await owner(actor, async () => {
      const session = await prisma.companionSession.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: bot.threadId,
          historyGeneration: 0,
          engineUserId: randomUUID(),
          engineSessionId: randomUUID(),
          engineInstanceId: randomUUID(),
        },
      });
      await prisma.companionTurn.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          runId: run.runId!,
          sessionId: session.id,
          clientMessageId: randomUUID(),
          input: "Recover this input",
          status: "completed",
          response: "Already saved remotely",
        },
      });
    });
    const h = harness(async function* () {
      forbidden();
      yield final("unreachable");
    });
    await owner(actor, () => h.executor.continueRun(run.runId!, "recovery-worker"));
    await owner(actor, () => h.executor.continueRun(run.runId!, "another-worker"));
    expect(h.requests).toEqual([]);
    expect(h.provision).not.toHaveBeenCalled();
    await assertCompleted(bot, run.runId!, "Already saved remotely");
  });

  it("replays an uncertain accepted request with its durable UUID and input before sending a later turn", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    await owner(actor, () =>
      prisma.bot.update({
        where: { id: bot.id },
        data: { conversationEngineSettings: { tier: "initial" } },
      }),
    );
    const h = harness(async function* (input) {
      if (h.requests.length === 1) throw new ConversationEngineError("uncertain", true);
      yield final(input.text === "First" ? "Recovered first response" : "Second response");
    });
    const first = await send(bot, "First");
    await owner(actor, () => h.executor.continueRun(first.runId!, "initial-worker"));
    await owner(actor, async () => {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe(
        "failed",
      );
      expect(
        (await prisma.companionTurn.findUniqueOrThrow({ where: { runId: first.runId! } })).status,
      ).toBe("uncertain");
    });
    const second = await send(bot, "Second");
    // A settings change cannot rewrite an already accepted request, including during recovery.
    await owner(actor, () =>
      prisma.bot.update({
        where: { id: bot.id },
        data: { conversationEngineSettings: { tier: "changed" } },
      }),
    );
    // A new executor instance has no in-memory request or session state.
    const resumed = h.restart();
    await owner(actor, () => resumed.continueRun(second.runId!, "replacement-worker"));
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1]).toEqual(h.requests[0]);
    expect(h.requests[1]!.settings).toEqual({ tier: "initial" });
    expect(h.requests[2]!.settings).toEqual({ tier: "changed" });
    expect(h.requests[2]!.clientMessageId).not.toBe(h.requests[0]!.clientMessageId);
    expect(h.provision).toHaveBeenCalledTimes(1);
    await assertCompleted(bot, second.runId!, "Second response");
    await owner(actor, async () => {
      expect(await prisma.message.count({ where: { runId: first.runId!, role: "bot" } })).toBe(0);
      expect(
        (await prisma.companionTurn.findUniqueOrThrow({ where: { runId: first.runId! } })).status,
      ).toBe("completed");
    });
  });

  it("Stop detaches delivery and the next run reconciles the accepted request before creating a new request", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const h = harness(async function* (input, signal) {
      if (h.requests.length === 1) {
        ready();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      yield final(input.text === "Before Stop" ? "Detached answer" : "After Stop answer");
    });
    const first = await send(bot, "Before Stop");
    const work = owner(actor, () => h.executor.continueRun(first.runId!, "stopped-worker"));
    await started;
    await owner(actor, () =>
      prisma.$transaction(async (tx) => {
        const run = await tx.run.findUniqueOrThrow({ where: { id: first.runId! } });
        await cancelRunsInTransaction(tx, [run], new Date());
      }),
    );
    await work;
    const second = await send(bot, "After Stop");
    await owner(actor, () => h.executor.continueRun(second.runId!, "next-worker"));
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1]).toEqual(h.requests[0]);
    await assertCompleted(bot, second.runId!, "After Stop answer");
    await owner(actor, async () => {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe(
        "cancelled",
      );
      expect(await prisma.message.count({ where: { runId: first.runId!, role: "bot" } })).toBe(0);
      expect(
        (await prisma.companionTurn.findUniqueOrThrow({ where: { runId: first.runId! } })).status,
      ).toBe("completed");
    });
  });

  it("does not submit a new remote turn while the previous request is still running", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    const h = harness(async function* () {
      if (h.requests.length === 1) throw new ConversationEngineError("uncertain", true);
      if (h.requests.length > 1) throw new ConversationEngineError("duplicate_in_progress", true);
      yield final("unreachable");
    });
    const first = await send(bot, "Pending");
    await owner(actor, () => h.executor.continueRun(first.runId!, "first-worker"));
    const second = await send(bot, "Do not send yet");
    await owner(actor, () => h.executor.continueRun(second.runId!, "next-worker"));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toEqual(h.requests[0]);
    await owner(actor, async () => {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: second.runId! } })).status).toBe(
        "failed",
      );
      expect(await prisma.companionTurn.count({ where: { session: { botId: bot.id } } })).toBe(1);
    });
  });

  it("preserves an active session lease and resumes only after it expires", async () => {
    const actor = actors[0]!;
    const bot = await createBot();
    const first = await send(bot, "Wait for the existing generation");
    const leaseRunId = "other-run";
    const binding = await owner(actor, () =>
      prisma.companionSession.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          threadId: bot.threadId,
          historyGeneration: 0,
          engineUserId: randomUUID(),
          engineSessionId: randomUUID(),
          engineInstanceId: randomUUID(),
          leaseRunId,
          leaseFence: 7,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    const h = harness(async function* () {
      yield final("After lease expiry");
    });
    await owner(actor, () => h.executor.continueRun(first.runId!, "contending-worker"));
    expect(h.requests).toEqual([]);
    expect(h.provision).not.toHaveBeenCalled();
    await owner(actor, async () => {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe(
        "failed",
      );
      expect(
        await prisma.companionSession.findUniqueOrThrow({ where: { id: binding.id } }),
      ).toMatchObject({ leaseRunId, leaseFence: 7 });
      await prisma.companionSession.update({
        where: { id: binding.id },
        data: { leaseExpiresAt: new Date(0) },
      });
    });
    const second = await send(bot, "Try again after expiry");
    await owner(actor, () => h.executor.continueRun(second.runId!, "later-worker"));
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.userId).toBe(binding.engineUserId);
    await assertCompleted(bot, second.runId!, "After lease expiry");
  });

  it.each([
    { text: "Fallback", ghost: true, truncated: false },
    { text: "Partial", ghost: false, truncated: true },
    { text: " ", ghost: false, truncated: false },
  ])("refuses to commit an unqualified final $text", async (response) => {
    const actor = actors[0]!;
    const bot = await createBot();
    const h = harness(async function* () {
      yield { type: "final", ...response };
    });
    const run = await send(bot, "Input");
    await owner(actor, () => h.executor.continueRun(run.runId!, "invalid-final-worker"));
    await owner(actor, async () => {
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.runId! } })).status).toBe(
        "failed",
      );
      expect(
        (await prisma.companionTurn.findUniqueOrThrow({ where: { runId: run.runId! } })).status,
      ).toBe("failed");
      expect(await prisma.message.count({ where: { runId: run.runId!, role: "bot" } })).toBe(0);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: bot.threadId } })).roleplayState,
      ).toBeNull();
    });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("keeps tenants, bots, and history generations on distinct engine identities", async () => {
    const h = harness(async function* () {
      yield final("Isolated answer");
    });
    const bots = [
      await createBot(actors[0]!),
      await createBot(actors[0]!),
      await createBot(actors[1]!),
    ];
    for (const [index, bot] of bots.entries()) {
      const actor = actors[index === 2 ? 1 : 0]!;
      const run = await send(bot, "Hello", actor);
      await owner(actor, () => h.executor.continueRun(run.runId!, "identity-worker"));
      await assertCompleted(bot, run.runId!, "Isolated answer", actor);
    }
    const actor = actors[0]!;
    const bot = bots[0]!;
    await owner(actor, () =>
      prisma.thread.update({
        where: { id: bot.threadId },
        data: { historyCompactionGeneration: { increment: 1 } },
      }),
    );
    const run = await send(bot, "New generation");
    await owner(actor, () => h.executor.continueRun(run.runId!, "generation-worker"));
    expect(new Set(h.requests.map((request) => request.userId)).size).toBe(4);
    expect(new Set(h.requests.map((request) => request.sessionId)).size).toBe(4);
    await owner(actors[1]!, async () => {
      expect(await prisma.companionSession.findMany({ where: { botId: bot.id } })).toEqual([]);
      expect(await prisma.companionTurn.findMany({ where: { runId: run.runId! } })).toEqual([]);
    });
    const foreign = await owner(actors[1]!, () =>
      h.executor.continueRun(run.runId!, "foreign-worker"),
    );
    expect(foreign).toBeUndefined();
    expect(h.requests).toHaveLength(4);
  });
});
