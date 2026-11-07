import { farmingControlBotId } from "@rakazo/core";
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import type { SendUserMessageInput } from "./events.js";
import { claimSteering, sendUserMessage } from "./events.js";

it("rejects external delivery before persisting any private specialist message or steering", async () => {
  const transaction = vi.fn();
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  const input: SendUserMessageInput = {
    botId: farmingControlBotId("personal", "tax"),
    spaceId: "personal",
    userId: "owner",
    threadId: "thread",
    trigger: "messaging",
    prompt: "Outside message",
    blocks: [{ kind: "text", text: "Outside message" }],
  };
  for (const trigger of ["messaging", "webhook"] as const)
    await expect(sendUserMessage(prisma, { ...input, trigger })).rejects.toThrow(
      "only private owner app messages",
    );
  await expect(
    sendUserMessage(prisma, { ...input, trigger: "user", crossSpaceSenderBotId: "foreign-bot" }),
  ).rejects.toThrow("only private owner app messages");
  await expect(
    sendUserMessage(prisma, {
      ...input,
      trigger: "follow_up",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "other",
          fromBotName: "Other",
          text: "Legacy bot message",
        },
      ],
    }),
  ).rejects.toThrow("only private owner app messages");
  expect(transaction).not.toHaveBeenCalled();
});

it("leaves external and legacy bot steering unclaimed for a private specialist", async () => {
  const tx = {
    $queryRaw: vi.fn(),
    run: {
      findFirst: vi.fn(async () => ({
        id: "run",
        spaceId: "personal",
        userId: "owner",
        trigger: "user",
        sourceMessage: { blocks: [{ kind: "text", text: "Owner question" }] },
      })),
    },
    steeringMessage: {
      findMany: vi.fn(async () => [
        {
          id: "external",
          userId: "owner",
          originTrigger: "messaging",
          message: { blocks: [{ kind: "text", text: "Outside" }] },
        },
        {
          id: "legacy",
          userId: "owner",
          originTrigger: null,
          message: {
            blocks: [
              {
                kind: "bot_message_received",
                fromBotId: "other",
                fromBotName: "Other",
                text: "Outside",
              },
            ],
          },
        },
        {
          id: "foreign",
          userId: "foreign",
          originTrigger: null,
          message: { blocks: [{ kind: "text", text: "Outside" }] },
        },
      ]),
      updateMany: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  expect(
    await claimSteering(prisma, {
      threadId: "thread",
      botId: farmingControlBotId("personal", "tax"),
      runId: "run",
      leaseOwner: "worker",
      leaseFence: 1,
      seenIds: [],
    }),
  ).toEqual([]);
  expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
});
