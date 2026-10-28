import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeBrowserProvider,
  FakeSandboxProvider,
  finishWorkflowCancellation,
  LocalAgentHomeStore,
  reconcileWorkflows,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { Actor, WorkflowGraph } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInput,
  asSystem,
  attachWorkflowRecoveryInTransaction,
  createDb,
  createThreadEvents,
  getWorkflow,
  getWorkflowRun,
  pauseRunForInput,
  reconcileWorkflow,
  requestWorkflowCancellation,
  runAsSystem,
  runAsTenant,
  saveWorkflow,
  startWorkflow,
  WorkflowConflictError,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recoverConversationRun } from "./conversation-tasks.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
describePostgres("durable task-backed workflows (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let stranger: Actor;
  let botId: string;
  let otherBotId: string;
  let dataDir: string;
  const ids: string[] = [];
  const owner = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
  const sandbox = new FakeSandboxProvider();
  const jobs: JobPublisher = { enqueue: vi.fn(async () => undefined) };
  const graph = (): WorkflowGraph => ({
    nodes: ["a", "b", "join"].map((id, index) => ({
      id,
      label: id,
      botId: index === 1 ? otherBotId : botId,
      prompt: `Complete step ${id}`,
      x: index * 240,
      y: index === 2 ? 200 : 0,
    })),
    edges: [
      { from: "a", to: "join" },
      { from: "b", to: "join" },
    ],
  });
  async function fixtureActor() {
    const id = randomUUID();
    ids.push(id);
    await system.user.create({
      data: { id, name: "Workflow fixture", email: `${id}@example.invalid` },
    });
    await system.organization.create({
      data: { id, name: "Workflow fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, name: "Workflow fixture", organizationId: id } });
    return { spaceId: id, userId: id, email: `${id}@example.invalid`, isDeploymentOwner: false };
  }
  async function fixtureBot(name: string) {
    const computer = await system.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        kind: "fake",
        state: "running",
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        computerId: computer.id,
        name,
        color: "test",
      },
    });
    await system.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id },
    });
    return bot.id;
  }
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    actor = await fixtureActor();
    stranger = await fixtureActor();
    botId = await fixtureBot("Writer");
    otherBotId = await fixtureBot("Reviewer");
    dataDir = await mkdtemp(join(process.cwd(), ".workflow-test-"));
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });
  afterAll(async () => {
    if (system) {
      await system.organization.deleteMany({ where: { id: { in: ids } } });
      await system.user.deleteMany({ where: { id: { in: ids } } });
    }
    await close?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function start(value = graph()) {
    const workflow = await owner(() =>
      saveWorkflow(prisma, actor, { name: "Review pipeline", graph: value }),
    );
    const run = await owner(() =>
      startWorkflow(prisma, actor, {
        workflowId: workflow.id,
        revision: workflow.revision,
        clientNonce: randomUUID(),
      }),
    );
    return { workflow, run };
  }
  it("saves without executing, fences edits and ownership, and snapshots a deliberate idempotent start", async () => {
    const workflow = await owner(() =>
      saveWorkflow(prisma, actor, { name: "Saved only", graph: graph() }),
    );
    expect(await system.workflowRun.count({ where: { workflowId: workflow.id } })).toBe(0);
    await expect(
      runAsTenant(stranger, () => getWorkflow(prisma, stranger, workflow.id)),
    ).rejects.toThrow("Resource not found");
    await expect(
      runAsTenant(stranger, () =>
        saveWorkflow(prisma, stranger, { name: "Foreign bot", graph: graph() }),
      ),
    ).rejects.toThrow("Resource not found");
    const nonce = randomUUID();
    const starts = await owner(() =>
      Promise.all([
        startWorkflow(prisma, actor, { workflowId: workflow.id, revision: 1, clientNonce: nonce }),
        startWorkflow(prisma, actor, { workflowId: workflow.id, revision: 1, clientNonce: nonce }),
      ]),
    );
    expect(starts[0].id).toBe(starts[1].id);
    const edited = await owner(() =>
      saveWorkflow(prisma, actor, {
        workflowId: workflow.id,
        revision: 1,
        name: "Changed",
        graph: { nodes: [graph().nodes[0]!], edges: [] },
      }),
    );
    expect(edited.revision).toBe(2);
    await expect(
      owner(() =>
        saveWorkflow(prisma, actor, {
          workflowId: workflow.id,
          revision: 1,
          name: "Stale",
          graph: graph(),
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowConflictError);
    expect(
      (await owner(() => getWorkflowRun(prisma, actor, starts[0].id))).graph.nodes,
    ).toHaveLength(3);
    await expect(
      owner(() =>
        startWorkflow(prisma, actor, {
          workflowId: workflow.id,
          revision: 1,
          clientNonce: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowConflictError);
    await owner(() =>
      requestWorkflowCancellation(prisma, actor, {
        runId: starts[0].id,
        revision: starts[0].revision,
      }),
    );
    await owner(() => finishWorkflowCancellation({ prisma, sandbox }, actor, starts[0].id));
  });
  it("executes root tasks with the real executor, waits for approval, and durably joins exactly once after restart", async () => {
    const { run } = await start();
    const calls = await owner(() =>
      Promise.all([
        reconcileWorkflow(prisma, actor, run.id),
        reconcileWorkflow(prisma, actor, run.id),
      ]),
    );
    expect(calls.flat()).toHaveLength(2);
    let current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    expect(current.nodes.find((node) => node.nodeId === "join")!.taskId).toBeNull();
    const roots = current.nodes.filter((node) => node.taskId);
    const approvalRun = await system.run.update({
      where: { id: roots[0]!.runId! },
      data: { status: "running", leaseOwner: "approval-worker", leaseFence: 1 },
    });
    const approvalAttempt = await system.attempt.create({
      data: { runId: approvalRun.id, fence: 1, status: "running" },
    });
    const effect = await system.externalEffect.create({
      data: {
        spaceId: actor.spaceId,
        runId: approvalRun.id,
        kind: "write_file",
        status: "intended",
        idempotencyKey: `workflow-approval:${approvalRun.id}`,
        request: { path: "workflow-approved.txt", content: "approved fixture" },
      },
    });
    await owner(() =>
      pauseRunForInput(prisma, {
        spaceId: actor.spaceId,
        threadId: approvalRun.threadId,
        botId: approvalRun.botId,
        runId: approvalRun.id,
        attemptId: approvalAttempt.id,
        leaseOwner: "approval-worker",
        leaseFence: 1,
        blocks: [
          {
            kind: "ask",
            text: "Approve fixture command?",
            status: "pending",
            approvalEffectId: effect.id,
            actions: [
              { id: "allow", label: "Approve" },
              { id: "deny", label: "Reject" },
            ],
          },
        ],
      }),
    );
    await owner(() => reconcileWorkflow(prisma, actor, run.id));
    expect((await owner(() => getWorkflowRun(prisma, actor, run.id))).nodes[0]!.status).toBe(
      "waiting_approval",
    );
    expect(await owner(() => reconcileWorkflow(prisma, actor, run.id))).toEqual([]);
    const approvalMessage = await system.message.findFirstOrThrow({
      where: { runId: approvalRun.id, role: "bot" },
    });
    expect(
      await owner(() =>
        answerRunInput(prisma, {
          spaceId: actor.spaceId,
          threadId: approvalRun.threadId,
          runId: approvalRun.id,
          messageId: approvalMessage.id,
          answeredByUserId: actor.userId,
          answer: "allow",
        }),
      ),
    ).toBe(true);
    const requests: string[] = [];
    const runtime = {
      describe: () => new ScriptedAgentRuntime().describe(),
      abort: async () => undefined,
      async *run(request: AgentRunRequest) {
        requests.push(request.prompt);
        if (request.runId === approvalRun.id)
          yield {
            type: "tool" as const,
            name: "write_file",
            args: { path: "workflow-approved.txt", content: "approved fixture" },
            executionId: "approved-workflow-write",
          };
        yield { type: "done" as const, text: `Output ${request.runId}` };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: createThreadEvents(prisma),
      jobs,
      sandbox,
      browser: new FakeBrowserProvider(),
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: new MarkdownMemoryStore(prisma),
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("workflow-test-encryption-key"),
      secrets: [],
      deploymentModelKey: "workflow-test-key",
      deploymentModelConfigured: true,
      dataDir,
    });
    for (const root of roots)
      await owner(() => executor.continueRun(root.runId!, "workflow-test-worker"));
    const rootRows = await system.run.findMany({
      where: { id: { in: roots.map((node) => node.runId!) } },
      select: { id: true, status: true, error: true },
    });
    expect(rootRows).toEqual(rootRows.map((row) => ({ ...row, status: "completed", error: null })));
    const admission = await owner(() =>
      Promise.all([
        reconcileWorkflow(prisma, actor, run.id),
        reconcileWorkflow(prisma, actor, run.id),
      ]),
    );
    expect(admission.flat()).toHaveLength(1);
    current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    const joinNode = current.nodes.find((node) => node.nodeId === "join")!;
    const joinTask = await system.task.findUniqueOrThrow({ where: { id: joinNode.taskId! } });
    expect(joinTask.prompt).toContain("Previous step a:");
    expect(joinTask.prompt).toContain("Previous step b:");
    expect(joinTask.conversation).toBe(true);
    await owner(() => executor.continueRun(joinNode.runId!, "workflow-restarted-worker"));
    await runAsSystem("workflow reconciliation test", () =>
      reconcileWorkflows({ prisma, jobs, sandbox }),
    );
    current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    expect(current.status).toBe("succeeded");
    expect(current.nodes.every((node) => node.status === "succeeded")).toBe(true);
    expect(requests).toHaveLength(3);
    expect(await owner(() => reconcileWorkflow(prisma, actor, run.id))).toEqual([]);
  });
  it("blocks descendants after failure, rolls back stale recovery, and binds deliberate recovery atomically", async () => {
    const { run } = await start({
      nodes: [graph().nodes[0]!, graph().nodes[2]!],
      edges: [{ from: "a", to: "join" }],
    });
    await owner(() => reconcileWorkflow(prisma, actor, run.id));
    let current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    const sourceRunId = current.nodes[0]!.runId!;
    await system.run.update({
      where: { id: sourceRunId },
      data: { status: "failed", error: "Fixture stop", completedAt: new Date() },
    });
    await owner(() => reconcileWorkflow(prisma, actor, run.id));
    current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    expect(current.status).toBe("failed");
    expect(current.nodes[1]!.taskId).toBeNull();
    const nonce = randomUUID();
    const recover = (revision: number) =>
      owner(() =>
        recoverConversationRun(
          prisma,
          actor,
          { runId: sourceRunId, botId, clientNonce: nonce },
          sandbox,
          async (tx, task) => {
            await attachWorkflowRecoveryInTransaction(tx, actor, {
              runId: run.id,
              nodeId: "a",
              revision,
              sourceRunId,
              taskId: task.id,
              taskRunId: task.runId,
            });
          },
        ),
      );
    await expect(recover(current.revision - 1)).rejects.toBeInstanceOf(WorkflowConflictError);
    expect(await system.task.count({ where: { recoveryOfRunId: sourceRunId } })).toBe(0);
    const recovery = await recover(current.revision);
    expect(recovery.task.id).not.toBe(current.nodes[0]!.taskId);
    expect(
      (await system.task.findUniqueOrThrow({ where: { id: recovery.task.id } })).prompt,
    ).toContain("The previous execution may have completed effects");
    current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    expect(current.status).toBe("running");
    expect(current.nodes[0]!.taskId).toBe(recovery.task.id);
    await owner(() =>
      requestWorkflowCancellation(prisma, actor, { runId: current.id, revision: current.revision }),
    );
    await owner(() => finishWorkflowCancellation({ prisma, sandbox }, actor, run.id));
    expect(
      (await owner(() => getWorkflowRun(prisma, actor, run.id))).nodes.every(
        (node) => node.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: recovery.task.runId } })).status,
    ).toBe("cancelled");
    expect(await owner(() => reconcileWorkflow(prisma, actor, run.id))).toEqual([]);
  });
  it("retries failed cancellation against the pinned original process before permitting recovery", async () => {
    const { run } = await start({ nodes: [graph().nodes[0]!], edges: [] });
    await owner(() => reconcileWorkflow(prisma, actor, run.id));
    const current = await owner(() => getWorkflowRun(prisma, actor, run.id));
    const node = current.nodes[0]!;
    const bot = await system.bot.findUniqueOrThrow({ where: { id: botId } });
    const computer = await system.computer.update({
      where: { id: bot.computerId! },
      data: { providerRef: "workflow-host-fixture" },
    });
    await system.run.update({
      where: { id: node.runId! },
      data: {
        status: "running",
        nativeExecutionRunId: "original-native-process",
        nativeComputerId: computer.id,
        nativeComputerKey: computer.homeKey,
      },
    });
    await system.computerExecutionLease.deleteMany({ where: { computerId: computer.id, botId } });
    await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId,
        runId: node.runId!,
        fence: 7,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await owner(() =>
      requestWorkflowCancellation(prisma, actor, { runId: run.id, revision: current.revision }),
    );
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host disconnected"))
      .mockRejectedValueOnce(new Error("Still disconnected"))
      .mockResolvedValue(undefined);
    const stoppingSandbox = Object.assign(new FakeSandboxProvider(), { cancelRunWork: cancel });
    await expect(
      owner(() => finishWorkflowCancellation({ prisma, sandbox: stoppingSandbox }, actor, run.id)),
    ).rejects.toThrow("Host disconnected");
    expect(
      (await system.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).cancelPending,
    ).toBe(true);
    expect((await system.run.findUniqueOrThrow({ where: { id: node.runId! } })).status).toBe(
      "cancelled",
    );
    expect(
      (
        await system.computerExecutionLease.findFirstOrThrow({ where: { runId: node.runId! } })
      ).expiresAt.getTime(),
    ).toBeGreaterThan(Date.now());
    const oldScanTime = new Date("2020-01-01T00:00:00.000Z");
    await system.workflowRun.update({ where: { id: run.id }, data: { updatedAt: oldScanTime } });
    await runAsSystem("workflow failed cancellation fairness test", () =>
      reconcileWorkflows({ prisma, jobs, sandbox: stoppingSandbox }),
    );
    const pending = await system.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(pending.cancelPending).toBe(true);
    expect(pending.updatedAt.getTime()).toBeGreaterThan(oldScanTime.getTime());
    await runAsSystem("workflow cancellation retry test", () =>
      reconcileWorkflows({ prisma, jobs, sandbox: stoppingSandbox }),
    );
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(cancel.mock.calls[2]![2]).toBe("original-native-process");
    expect(cancel.mock.calls[2]![3]).toMatchObject({
      requireRunCleanup: true,
      runId: node.runId,
    });
    expect(
      (await system.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).cancelPending,
    ).toBe(false);
    expect((await owner(() => getWorkflowRun(prisma, actor, run.id))).nodes[0]!.status).toBe(
      "cancelled",
    );
  });
});
