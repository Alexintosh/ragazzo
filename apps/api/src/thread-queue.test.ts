import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { QueueTarget } from "./thread-queue.js";
import { queueState } from "./thread-queue.js";

describe("thread queue runtime steering", () => {
  it.each(["pi", "codex", "claude", "acp"])(
    "offers only acknowledged steering for active conversational %s runs",
    async (runtimeKind) => {
      const tx = {
        thread: { findFirst: vi.fn(async () => ({ nextEventSeq: 5 })) },
        steeringMessage: {
          findMany: vi.fn(async () => [
            {
              id: "queued",
              messageId: "message",
              botId: "bot",
              deliveryMode: "queue",
              message: { seq: 1, blocks: [{ kind: "text", text: "Use blue" }] },
            },
          ]),
        },
        run: {
          findFirst: vi.fn(async () => ({ id: "active", status: "running", trigger: "user" })),
        },
        event: { findFirst: vi.fn(async () => null) },
      };
      const target = {
        kind: "bot",
        botId: "bot",
        threadId: "thread",
        bot: { name: "Assistant", runtimeKind },
      } as QueueTarget;
      const actor = { userId: "user", spaceId: "space" } as Actor;
      const result = await queueState(tx as unknown as Prisma.TransactionClient, actor, target);
      const canSteer = runtimeKind === "pi" || runtimeKind === "codex";
      expect(result.snapshot).toMatchObject({ canSteer, entries: [{ canSteer }] });
      tx.run.findFirst.mockResolvedValue({
        id: "active",
        status: "waiting_input",
        trigger: "user",
      });
      expect(
        (await queueState(tx as unknown as Prisma.TransactionClient, actor, target)).snapshot
          .canSteer,
      ).toBe(false);
    },
  );
});
