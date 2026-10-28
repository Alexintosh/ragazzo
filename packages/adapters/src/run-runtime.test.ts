import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { nativeRuntimeAnswer, runtimeForBot } from "./run-runtime.js";

describe("per-bot runtime boundary", () => {
  const pi = {} as AgentRuntime;
  const codex = {} as AgentRuntime;
  const deps = { runtime: pi, runtimes: { codex } };
  it("keeps legacy bots on Pi and selects only a configured native host runtime", () => {
    expect(runtimeForBot(deps, {})).toBe(pi);
    expect(runtimeForBot(deps, { runtimeKind: "pi" })).toBe(pi);
    const bot = { runtimeKind: "codex", executionTarget: "host", projectPath: "/project" };
    expect(runtimeForBot(deps, bot)).toBe(codex);
    expect(() => runtimeForBot({ runtime: pi }, bot)).toThrow("configured local host");
    expect(() => runtimeForBot(deps, { ...bot, executionTarget: "docker" })).toThrow(
      "host computer",
    );
  });
  it.each(["claude", "acp"] as const)("routes %s through its configured native adapter", (kind) => {
    const native = {} as AgentRuntime;
    expect(
      runtimeForBot(
        { runtime: pi, runtimes: { [kind]: native } },
        { runtimeKind: kind, executionTarget: "host", projectPath: "/project" },
      ),
    ).toBe(native);
  });
  it("uses the persisted answer ID, with ownership and run scoping", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { blocks: [{ kind: "ask", text: "Allow?", status: "answered", answer: "reject" }] },
      ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    const run = { id: "run-a", threadId: "thread-a", botId: "bot-a" };
    expect(await nativeRuntimeAnswer(prisma, run)).toEqual({
      content: [{ type: "text", text: "reject" }],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: "run-a", threadId: "thread-a", botId: "bot-a", role: "bot" },
        orderBy: { seq: "desc" },
      }),
    );
  });
  it("never reuses an older approval while the latest question is pending", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          { blocks: [{ kind: "ask", text: "New action?", status: "pending" }] },
          {
            blocks: [{ kind: "ask", text: "Old action?", status: "answered", answer: "approve" }],
          },
        ]),
      },
    } as unknown as PrismaClient;
    expect(
      await nativeRuntimeAnswer(prisma, { id: "r", threadId: "t", botId: "b" }),
    ).toBeUndefined();
  });
  it("binds every resumed native answer to the exact persisted interaction", async () => {
    const blocks = [
      {
        kind: "ask",
        text: "Original intro",
        status: "answered",
        answer: "original task",
        nativeInteractionId: "intro",
      },
    ];
    const prisma = {
      message: { findMany: vi.fn(async () => [{ blocks }]) },
    } as unknown as PrismaClient;
    const run = { id: "run", threadId: "thread", botId: "bot" };
    expect(
      await nativeRuntimeAnswer(prisma, run, { interactionId: "child-question" }),
    ).toBeUndefined();
    expect(
      await nativeRuntimeAnswer(prisma, run, { interactionId: "intro", ordinaryQuestion: true }),
    ).toEqual({ content: [{ type: "text", text: "original task" }] });
    blocks[0] = { ...blocks[0]!, nativeInteractionId: "child-question", answer: "child answer" };
    expect(await nativeRuntimeAnswer(prisma, run, { interactionId: "child-question" })).toEqual({
      content: [{ type: "text", text: "child answer" }],
    });
  });
  it.each([
    {
      nativeApproval: true,
      actions: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    },
    { input: "secret" },
  ])(
    "does not treat a persisted approval or secret as intro task authority (%j)",
    async (patch) => {
      const prisma = {
        message: {
          findMany: vi.fn(async () => [
            {
              blocks: [
                {
                  kind: "ask",
                  text: "Sensitive interaction",
                  status: "answered",
                  answer: "approve",
                  nativeInteractionId: "interaction",
                  ...patch,
                },
              ],
            },
          ]),
        },
      } as unknown as PrismaClient;
      expect(
        await nativeRuntimeAnswer(
          prisma,
          { id: "run", threadId: "thread", botId: "bot" },
          { interactionId: "interaction", ordinaryQuestion: true },
        ),
      ).toBeUndefined();
    },
  );
});
