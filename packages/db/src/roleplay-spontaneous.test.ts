import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  parseRoleplaySpontaneousGuard,
  roleplaySpontaneousSnapshot,
  sameRoleplaySpontaneousGuard,
} from "./roleplay-spontaneous.js";

const now = new Date("2026-10-29T12:00:00Z");
const old = new Date("2026-10-27T12:00:00Z");
function fixture() {
  const character = {
    name: "Aria",
    description: "Explorer",
    personality: "Curious",
    scenario: "",
    firstMessage: "Hello",
    exampleDialogue: "",
    alternateGreetings: [],
    systemPrompt: "",
    postHistoryInstructions: "",
    lorebook: null,
    conversationStyle: "chat",
    spontaneous: { enabled: true, frequency: "balanced", allowLateNight: false },
  };
  const bot = { botKind: "roleplay", roleplayCharacter: character, updatedAt: old };
  const thread = {
    botId: "aria",
    taskBotId: null,
    nextMessageSeq: 8,
    historyCompactionGeneration: 0,
    roleplayState: null,
  };
  const user = { timezone: "UTC" as string | null, updatedAt: old, nativeSetupDisabledAt: null };
  const runs: Array<{
    id: string;
    threadId: string;
    createdAt: Date;
    status: string;
    firstResponseAt: Date | null;
    startedAt?: Date | null;
  }> = [];
  let busy = false;
  let unanswered = false;
  let started = true;
  const db = {
    $queryRaw: vi.fn(async () => []),
    bot: { findFirst: vi.fn(async () => bot) },
    thread: { findFirst: vi.fn(async () => thread) },
    user: { findUnique: vi.fn(async () => user) },
    run: {
      findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => runs),
      findFirst: vi.fn(async ({ where }) =>
        where.status === "completed"
          ? unanswered
            ? { id: "prior-send" }
            : null
          : busy
            ? { id: "busy" }
            : null,
      ),
    },
    message: {
      findFirst: vi.fn(async ({ where }) =>
        where.role
          ? started
            ? { id: "user-message", seq: 6, createdAt: old }
            : null
          : { createdAt: old },
      ),
      count: vi.fn(async () => (started ? 4 : 0)),
      findMany: vi.fn(async () => [
        { role: "bot" },
        { role: "user" },
        { role: "bot" },
        { role: "user" },
      ]),
    },
  };
  const identity = { userId: "owner", spaceId: "space", botId: "aria", threadId: "story" };
  const snapshot = () =>
    roleplaySpontaneousSnapshot(
      db as unknown as Prisma.TransactionClient,
      identity,
      now,
      "current",
    );
  return {
    db,
    character,
    bot,
    thread,
    user,
    runs,
    snapshot,
    setBusy: () => (busy = true),
    setUnanswered: () => (unanswered = true),
    setUnstarted: () => (started = false),
  };
}
describe("roleplay initiative facts", () => {
  it("uses real message timestamps/counts and captures preference/history revisions", async () => {
    const f = fixture();
    const result = await f.snapshot();
    expect(result?.guard).toMatchObject({
      sourceMessageId: "user-message",
      nextMessageSeq: 8,
      historyGeneration: 0,
      timezone: "UTC",
      botUpdatedAt: old.toISOString(),
      userUpdatedAt: old.toISOString(),
    });
    expect(JSON.stringify(result?.guard)).not.toContain("Explorer");
    expect(result?.guard.character).toMatch(/^[a-f0-9]{64}$/);
    expect(parseRoleplaySpontaneousGuard(JSON.stringify(result?.guard))).toEqual(result?.guard);
    expect(f.db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "owner", id: { not: "current" } }),
        take: 100,
      }),
    );
    expect(f.db.run.findMany.mock.calls[0]![0].where).not.toHaveProperty("spaceId");
  });
  it.each(["disabled", "narrative", "timezone", "busy", "unanswered", "unstarted"])(
    "fails closed for %s",
    async (reason) => {
      const f = fixture();
      if (reason === "disabled") f.character.spontaneous.enabled = false;
      if (reason === "narrative") f.character.conversationStyle = "narrative";
      if (reason === "timezone") f.user.timezone = null;
      if (reason === "busy") f.setBusy();
      if (reason === "unanswered") f.setUnanswered();
      if (reason === "unstarted") f.setUnstarted();
      expect(await f.snapshot()).toBeNull();
    },
  );
  it("counts skips as attempts and sends from the owner's other Spaces", async () => {
    const f = fixture();
    f.runs.push({
      id: "skipped",
      threadId: "other-space-story",
      createdAt: new Date("2026-10-29T11:00:00Z"),
      status: "completed",
      firstResponseAt: null,
    });
    expect(await f.snapshot()).toBeNull();
    f.runs.splice(
      0,
      1,
      ...["09", "06"].map((hour) => ({
        id: `sent-${hour}`,
        threadId: "other-space-story",
        createdAt: new Date(`2026-10-29T${hour}:00:00Z`),
        status: "completed",
        firstResponseAt: new Date(`2026-10-29T${hour}:05:00Z`),
      })),
    );
    expect(await f.snapshot()).toBeNull();
  });
  it("rejects every changed guard field, including edit then restore revisions", async () => {
    const guard = (await fixture().snapshot())!.guard;
    for (const key of Object.keys(guard) as Array<keyof typeof guard>) {
      expect(
        sameRoleplaySpontaneousGuard(guard, {
          ...guard,
          [key]: typeof guard[key] === "number" ? Number(guard[key]) + 1 : `${guard[key]}changed`,
        }),
      ).toBe(false);
    }
    expect(parseRoleplaySpontaneousGuard("{}")).toBeNull();
    expect(parseRoleplaySpontaneousGuard("invalid")).toBeNull();
  });
});

it("applies cooldown to delayed attempts at their actual start time", async () => {
  const f = fixture();
  f.runs.push({
    id: "delayed",
    threadId: "other-story",
    createdAt: old,
    startedAt: new Date("2026-10-29T11:55:00Z"),
    status: "completed",
    firstResponseAt: null,
  });
  expect(await f.snapshot()).toBeNull();
});
