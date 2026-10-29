import { describe, expect, it } from "vitest";
import {
  formatRoleplayMessageContent,
  roleplayMemoryWindow,
  roleplayMessageTokens,
  roleplayStoryState,
  roleplayTokens,
} from "./roleplay.js";
import {
  buildRoleplayContinuityRequest,
  parseRoleplayContinuity,
  roleplayRelationshipState,
  updateRoleplayRelationshipState,
} from "./roleplay-continuity.js";
import { buildRoleplayTemporalContext, roleplayLocalTime } from "./roleplay-temporal.js";

const continuity = {
  scene: "Chat",
  relationship: "Acquaintances",
  sharedDetails: [],
  openThreads: [],
  callbacks: [],
};

describe("dated story context", () => {
  it("retains original dates and newer correction provenance in extraction data", () => {
    const messages = [
      {
        seq: 1,
        role: "user" as const,
        content: "Let's meet tomorrow",
        createdAt: "2026-10-27T16:00:00Z",
      },
      {
        seq: 2,
        role: "user" as const,
        content: "Actually Friday instead",
        createdAt: "2026-10-28T16:00:00Z",
      },
    ];
    const prior = {
      ...continuity,
      datedEvents: [
        {
          id: "meeting",
          description: "Cafe meeting",
          date: "2026-10-28",
          status: "planned" as const,
          sourceMessageSeq: 1,
          sourceMessageAt: messages[0]!.createdAt,
        },
      ],
    };
    const data = JSON.parse(
      buildRoleplayContinuityRequest({
        current: prior,
        messages,
        temporal: { now: "2026-10-29T12:00:00Z", timezone: "Europe/Lisbon" },
      }).prompt,
    );
    expect(data.priorContinuity.datedEvents).toEqual(prior.datedEvents);
    expect(data.recentMessages).toEqual(messages);
    const corrected = {
      ...prior,
      datedEvents: [
        {
          ...prior.datedEvents[0],
          date: "2026-10-30",
          sourceMessageSeq: 2,
          sourceMessageAt: messages[1]!.createdAt,
        },
      ],
    };
    expect(parseRoleplayContinuity(JSON.stringify(corrected))).toEqual(corrected);
  });

  it("computes elapsed real time without modifying fictional event state", () => {
    const context = buildRoleplayTemporalContext(
      {
        now: "2026-10-29T12:00:00Z",
        timezone: "Europe/Lisbon",
        lastInteractionAt: "2026-10-27T12:00:00Z",
      },
      "narrative",
    );
    expect(JSON.parse(context.split("\n\n")[1]!)).toMatchObject({
      now: "2026-10-29T12:00:00Z",
      timezone: "Europe/Lisbon",
      lastInteractionAt: "2026-10-27T12:00:00Z",
      elapsedMilliseconds: 172_800_000,
    });
    expect(roleplayLocalTime("2026-10-29T12:00:00Z", "Unknown/Zone")).toBeNull();
    expect(roleplayLocalTime("bad date", "Europe/Lisbon")).toBeNull();
    expect(
      JSON.parse(buildRoleplayTemporalContext({ now: "2026-10-29T12:00:00Z" }).split("\n\n")[1]!)
        .timezone,
    ).toBeNull();
  });

  it("budgets model-visible timestamp wrappers in the memory window", () => {
    const message = {
      seq: 1,
      role: "user" as const,
      content: "Tomorrow",
      createdAt: "2026-10-29T12:00:00Z",
    };
    const content = formatRoleplayMessageContent(message);
    expect(content).toBe("[Message createdAt: 2026-10-29T12:00:00Z]\nTomorrow");
    const budget = roleplayMessageTokens(message);
    expect(budget).toBe(roleplayTokens(content) + 8);
    expect(roleplayMemoryWindow([message], budget).recent).toEqual([message]);
    expect(roleplayMemoryWindow([message], budget - 1).older).toEqual([message]);
  });

  it("preserves retained input timestamps across story-state compaction and legacy state", () => {
    const scope = { threadId: "thread", botId: "bot", historyGeneration: 0 };
    const state = roleplayStoryState(null, scope);
    const message = {
      seq: 1,
      role: "user",
      content: "Tomorrow",
      createdAt: "2026-10-29T12:00:00Z",
    };
    expect(
      roleplayStoryState({ ...state, summarizedUpToSeq: 1, retainedInputs: [message] }, scope)
        .retainedInputs,
    ).toEqual([message]);
    expect(roleplayStoryState({ ...state, continuity }, scope).continuity).toEqual(continuity);
  });
});

describe("character relationship state", () => {
  it("uses a safe legacy default without claiming human feelings", () => {
    expect(roleplayRelationshipState(undefined)).toEqual({ warmth: 10, intimacy: 0, love: 0 });
    expect(roleplayRelationshipState({ warmth: 101, intimacy: 0, love: 0 })).toEqual({
      warmth: 10,
      intimacy: 0,
      love: 0,
    });
    expect(roleplayRelationshipState({ warmth: 100, intimacy: 100, love: 100 })).toEqual({
      warmth: 100,
      intimacy: 100,
      love: 100,
    });
  });

  it("bounds model changes in both directions per real user turn", () => {
    expect(
      updateRoleplayRelationshipState(
        { warmth: 50, intimacy: 50, love: 50 },
        { warmth: 100, intimacy: 0, love: 52 },
        { realUserTurn: true },
      ),
    ).toEqual({ warmth: 55, intimacy: 45, love: 52 });
    expect(
      updateRoleplayRelationshipState(
        undefined,
        { warmth: 100, intimacy: 100, love: 100 },
        { realUserTurn: false },
      ),
    ).toEqual({ warmth: 10, intimacy: 0, love: 0 });
    expect(
      updateRoleplayRelationshipState(
        { warmth: 50, intimacy: 50, love: 50 },
        {},
        { realUserTurn: true },
      ),
    ).toEqual({ warmth: 50, intimacy: 50, love: 50 });
  });
});
