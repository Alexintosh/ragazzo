import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { deriveRunWaitingDetail } from "./waiting-detail.js";
import { readRunWaitingDetail } from "./workflows.js";

const run = {
  id: "synthetic-run-question",
  status: "waiting_input",
  threadId: "thread",
  botId: "bot",
};
const ask = { kind: "ask", text: "Which city?", status: "pending" };
const message = (block: unknown, runId = run.id) => ({
  id: "synthetic-request-question",
  runId,
  blocks: [block],
});
const approval = {
  ...ask,
  approvalEffectId: "effect",
  actions: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
};
const effect = { id: "effect", runId: run.id, kind: "send_email", status: "intended" };
const reference = { runId: run.id, messageId: "synthetic-request-question" };
const generic = { reason: "waiting", runId: run.id };
const computerCard = { kind: "computer", state: "Needs you", text: "Sign in" };

describe("waiting detail decision", () => {
  it.each([
    { name: "ordinary question", block: ask, effects: [], reason: "question", action: "answer" },
    {
      name: "choice question",
      block: { ...ask, actions: [{ id: "one", label: "One" }] },
      effects: [],
      reason: "question",
      action: "answer",
    },
    {
      name: "approval",
      block: approval,
      effects: [effect],
      reason: "approval",
      action: "review_approval",
    },
    {
      name: "native approval",
      block: {
        ...ask,
        nativeApproval: true,
        actions: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
      },
      effects: [],
      reason: "approval",
      action: "review_approval",
    },
    {
      name: "secret",
      block: {
        ...ask,
        input: "secret",
        answer: "synthetic-secret-value",
        detail: "private detail",
      },
      effects: [],
      reason: "secret",
      action: "provide_secret",
    },
  ])("projects $name without copying request content", ({ block, effects, reason, action }) => {
    expect(deriveRunWaitingDetail({ run, messages: [message(block)], effects })).toEqual({
      ...reference,
      reason,
      action,
    });
  });

  it.each(["queued", "leased", "running", "completed", "failed", "cancelled"])(
    "does not invent a wait for a %s run",
    (status) => {
      expect(
        deriveRunWaitingDetail({ run: { ...run, status }, messages: [message(ask)], effects: [] }),
      ).toBeUndefined();
    },
  );
  it.each([
    [],
    [message(ask, "another-run")],
    [message({ ...ask, status: "answered", answer: "One" })],
    [message({ kind: "ask", status: "pending" })],
    [message(approval)],
    [message({ ...ask, nativeApproval: true })],
  ])("uses generic waiting for missing, stale or unsupported evidence %#", (...messages) => {
    expect(deriveRunWaitingDetail({ run, messages, effects: [] })).toEqual(generic);
  });
  it.each([
    { ...effect, status: "completed" },
    { ...effect, runId: "another-run" },
  ])("does not use an answered or other-run approval effect", (stale) => {
    expect(
      deriveRunWaitingDetail({ run, messages: [message(approval)], effects: [stale] }),
    ).toEqual(generic);
  });
  it("ignores another run's question and uses the relevant pending one", () => {
    expect(
      deriveRunWaitingDetail({
        run,
        messages: [message(approval, "other"), message(ask)],
        effects: [],
      }),
    ).toEqual({ ...reference, reason: "question", action: "answer" });
  });
  it("uses the newest pending card and falls back safely when its approval is unavailable", () => {
    expect(
      deriveRunWaitingDetail({ run, messages: [message(approval), message(ask)], effects: [] }),
    ).toEqual(generic);
  });
  it.each([true, false])("reports takeover with action availability %s", (canTakeover) => {
    expect(
      deriveRunWaitingDetail({
        run: { ...run, status: "waiting_takeover" },
        messages: [message(computerCard)],
        effects: [],
        canTakeover,
      }),
    ).toEqual({ ...reference, reason: "takeover", ...(canTakeover ? { action: "takeover" } : {}) });
  });
  it("does not resurrect a released takeover card", () => {
    expect(
      deriveRunWaitingDetail({
        run: { ...run, status: "waiting_takeover" },
        messages: [message({ ...computerCard, state: "Done" })],
        effects: [],
        canTakeover: true,
      }),
    ).toEqual(generic);
  });
});

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "user@example.invalid",
  isDeploymentOwner: false,
};
function fixture(status = "waiting_input") {
  return {
    run: { findFirst: vi.fn(async () => ({ ...run, status })) },
    message: { findMany: vi.fn(async () => [message(ask)]) },
    externalEffect: { findMany: vi.fn(async () => []) },
    bot: { findFirst: vi.fn(async () => null) },
  };
}
describe("waiting evidence reader", () => {
  it("reads only approval effects referenced by the bounded same-run message sample", async () => {
    const tx = fixture();
    tx.message.findMany.mockResolvedValue([message(approval)]);
    await readRunWaitingDetail(tx as unknown as Prisma.TransactionClient, actor, run.id);
    expect(tx.externalEffect.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["effect"] }, runId: run.id, spaceId: "space", status: "intended" },
      take: 1,
      select: { id: true, runId: true, kind: true, status: true },
    });
  });
  it.each([
    {
      state: "running",
      providerRef: "fake",
      userId: "user",
      controlRunId: run.id,
      leaseRunId: null,
      allowed: true,
    },
    {
      state: "running",
      providerRef: "fake",
      userId: "user",
      controlRunId: null,
      leaseRunId: run.id,
      allowed: true,
    },
    {
      state: "running",
      providerRef: "fake",
      userId: "user",
      controlRunId: "other-run",
      leaseRunId: "other-run",
      allowed: false,
    },
    {
      state: "stopped",
      providerRef: "fake",
      userId: "user",
      controlRunId: run.id,
      leaseRunId: null,
      allowed: false,
    },
    {
      state: "running",
      providerRef: null,
      userId: "user",
      controlRunId: run.id,
      leaseRunId: null,
      allowed: false,
    },
    {
      state: "running",
      providerRef: "fake",
      userId: "other-user",
      controlRunId: run.id,
      leaseRunId: null,
      allowed: false,
    },
  ])(
    "offers takeover only for the owned running computer tied to this request %#",
    async ({ leaseRunId, allowed, ...computer }) => {
      const tx = {
        run: { findFirst: vi.fn(async () => ({ ...run, status: "waiting_takeover" })) },
        message: { findMany: vi.fn(async () => [message(computerCard)]) },
        bot: {
          findFirst: vi.fn(async () => ({
            computer: {
              ...computer,
              spaceId: "space",
              executionLeases: leaseRunId ? [{ runId: leaseRunId }] : [],
            },
          })),
        },
      };
      const detail = await readRunWaitingDetail(
        tx as unknown as Prisma.TransactionClient,
        actor,
        run.id,
      );
      expect(detail).toEqual({
        ...reference,
        reason: "takeover",
        ...(allowed ? { action: "takeover" } : {}),
      });
      expect(tx.bot.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bot", spaceId: "space", userId: "user", archivedAt: null },
        }),
      );
    },
  );
  it("scopes run, message and effect reads and selects no secret storage", async () => {
    const tx = fixture();
    expect(
      await readRunWaitingDetail(tx as unknown as Prisma.TransactionClient, actor, run.id, {
        botId: "bot",
        taskId: "task",
      }),
    ).toEqual({ ...reference, reason: "question", action: "answer" });
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: run.id,
          botId: "bot",
          taskId: "task",
          spaceId: "space",
          userId: "user",
          bot: { spaceId: "space", userId: "user", archivedAt: null },
        },
      }),
    );
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: { threadId: "thread", runId: run.id, role: "bot" },
      orderBy: { seq: "desc" },
      take: 50,
      select: { id: true, runId: true, blocks: true },
    });
    expect(tx.externalEffect.findMany).not.toHaveBeenCalled();
  });
  it("reads no cards or effects for terminal or inaccessible runs", async () => {
    const tx = fixture("completed");
    expect(
      await readRunWaitingDetail(tx as unknown as Prisma.TransactionClient, actor, run.id),
    ).toBeUndefined();
    expect(tx.message.findMany).not.toHaveBeenCalled();
    tx.run.findFirst.mockResolvedValueOnce(null as never);
    expect(
      await readRunWaitingDetail(tx as unknown as Prisma.TransactionClient, actor, run.id),
    ).toBeUndefined();
    expect(tx.externalEffect.findMany).not.toHaveBeenCalled();
  });
});
