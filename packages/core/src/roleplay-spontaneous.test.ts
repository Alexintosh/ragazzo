import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { RoleplaySpontaneousEligibilityInput } from "./roleplay-spontaneous.js";
import {
  buildRoleplaySpontaneousRequest,
  evaluateRoleplaySpontaneousEligibility,
  parseRoleplaySpontaneousDecision,
} from "./roleplay-spontaneous.js";

const character = {
  ...parseRoleplayCharacterJson(JSON.stringify({ name: "Mira", conversationStyle: "chat" }))
    .character,
  spontaneous: { enabled: true, frequency: "balanced" as const, allowLateNight: false },
};
const facts: RoleplaySpontaneousEligibilityInput = {
  character,
  now: "2026-10-29T12:00:00Z",
  timezone: "Europe/Lisbon",
  lastUserMessageAt: "2026-10-27T12:00:00Z",
  realUserMessageCount: 8,
  reciprocalUserReplyCount: 6,
  unansweredSpontaneousCount: 0,
  spontaneousSentAt: [],
  attemptedAt: [],
};
const eligibility = (overrides: Partial<RoleplaySpontaneousEligibilityInput> = {}) =>
  evaluateRoleplaySpontaneousEligibility({ ...facts, ...overrides });

describe("spontaneous contact policy", () => {
  it("requires explicit chat opt-in and an actual user's first message", () => {
    expect(eligibility()).toEqual({ eligible: true, reason: "eligible" });
    expect(eligibility({ character: { ...character, spontaneous: undefined } }).reason).toBe(
      "disabled",
    );
    expect(
      eligibility({ character: { ...character, conversationStyle: "narrative" } }).reason,
    ).toBe("not-chat");
    expect(eligibility({ realUserMessageCount: 0, lastUserMessageAt: null }).reason).toBe(
      "not-started",
    );
    expect(eligibility({ lastUserMessageAt: null }).reason).toBe("not-started");
  });

  it.each([null, "", "Unknown/Somewhere"])("fails closed on unknown timezone %s", (timezone) => {
    expect(eligibility({ timezone }).reason).toBe("unknown-timezone");
  });

  it("stops after one unanswered contact until the user replies", () => {
    expect(eligibility({ unansweredSpontaneousCount: 1 }).reason).toBe("unanswered");
    expect(eligibility({ unansweredSpontaneousCount: 3 }).reason).toBe("unanswered");
  });

  it.each([
    ["2026-10-29T08:59:00Z", false, false],
    ["2026-10-29T09:00:00Z", false, true],
    ["2026-10-29T20:59:00Z", false, true],
    ["2026-10-29T21:00:00Z", false, false],
    ["2026-10-29T23:59:00Z", true, true],
    ["2026-10-29T00:59:00Z", true, true],
    ["2026-10-29T01:00:00Z", true, false],
    ["2026-10-29T08:59:00Z", true, false],
  ])("honors local quiet boundaries at %s with late night %s", (now, allowLateNight, eligible) => {
    expect(
      eligibility({
        now,
        character: { ...character, spontaneous: { ...character.spontaneous, allowLateNight } },
      }).eligible,
    ).toBe(eligible);
  });

  it("uses the user's DST offset rather than server time or fixed offsets", () => {
    expect(
      eligibility({ now: "2026-03-28T08:30:00Z", lastUserMessageAt: "2026-03-20T00:00:00Z" })
        .reason,
    ).toBe("quiet-hours");
    expect(
      eligibility({ now: "2026-03-29T08:30:00Z", lastUserMessageAt: "2026-03-20T00:00:00Z" })
        .eligible,
    ).toBe(true);
    expect(
      eligibility({ now: "2026-10-24T08:30:00Z", lastUserMessageAt: "2026-10-20T00:00:00Z" })
        .eligible,
    ).toBe(true);
    expect(
      eligibility({ now: "2026-10-25T08:30:00Z", lastUserMessageAt: "2026-10-20T00:00:00Z" })
        .reason,
    ).toBe("quiet-hours");
  });

  it.each([
    ["gentle", 1, 24],
    ["balanced", 2, 12],
    ["frequent", 3, 6],
  ] as const)("respects %s frequency's user cap and inactivity", (frequency, cap, hours) => {
    const configured = { ...character, spontaneous: { ...character.spontaneous, frequency } };
    expect(
      eligibility({
        character: configured,
        spontaneousSentAt: Array(cap).fill("2026-10-28T13:00:00Z"),
      }).reason,
    ).toBe("daily-cap");
    expect(
      eligibility({
        character: configured,
        lastUserMessageAt: new Date(Date.parse(facts.now) - hours * 3_600_000 + 1).toISOString(),
      }).reason,
    ).toBe("inactive-too-briefly");
    expect(
      eligibility({
        character: configured,
        lastUserMessageAt: new Date(Date.parse(facts.now) - hours * 3_600_000).toISOString(),
      }).eligible,
    ).toBe(true);
  });

  it("uses a rolling UTC 24-hour cap, including sends before local midnight", () => {
    expect(
      eligibility({ spontaneousSentAt: ["2026-10-28T13:00:00Z", "2026-10-28T23:00:00Z"] }).reason,
    ).toBe("daily-cap");
    expect(
      eligibility({ spontaneousSentAt: ["2026-10-28T12:00:00Z", "2026-10-27T23:00:00Z"] }).eligible,
    ).toBe(true);
    expect(
      eligibility({
        warmth: 100,
        spontaneousSentAt: ["2026-10-28T13:00:00Z", "2026-10-28T23:00:00Z"],
      }).reason,
    ).toBe("daily-cap");
  });

  it("eases only inactivity with both character warmth and actual reciprocal replies", () => {
    const lastUserMessageAt = "2026-10-29T03:00:00Z";
    expect(eligibility({ lastUserMessageAt }).reason).toBe("inactive-too-briefly");
    expect(
      eligibility({ lastUserMessageAt, warmth: 100, reciprocalUserReplyCount: 3 }).reason,
    ).toBe("inactive-too-briefly");
    expect(eligibility({ lastUserMessageAt, warmth: 39 }).reason).toBe("inactive-too-briefly");
    expect(eligibility({ lastUserMessageAt, warmth: 40 }).eligible).toBe(true);
    expect(eligibility({ warmth: 100, lastInteractionAt: "2026-10-29T11:59:00Z" }).reason).toBe(
      "inactive-too-briefly",
    );
  });

  it("rate limits attempts even when every generation skipped", () => {
    expect(eligibility({ attemptedAt: ["2026-10-29T11:00:00Z"] }).reason).toBe("attempt-cooldown");
    expect(eligibility({ attemptedAt: Array(8).fill("2026-10-29T08:00:00Z") }).reason).toBe(
      "attempt-cap",
    );
    expect(eligibility({ attemptedAt: ["2026-10-29T10:00:00Z"] }).eligible).toBe(true);
  });

  it.each([
    { realUserMessageCount: -1 },
    { reciprocalUserReplyCount: 1.5 },
    { unansweredSpontaneousCount: NaN },
    { attemptedAt: ["not-a-date"] },
    { spontaneousSentAt: ["2026-10-30T12:00:00Z"] },
    { warmth: 101 },
  ])("fails closed on invalid facts %j", (overrides) => {
    expect(eligibility(overrides).reason).toBe("invalid-facts");
  });
});

describe("spontaneous generation contract", () => {
  it("parses only complete bounded decisions with one to three bubbles", () => {
    expect(parseRoleplaySpontaneousDecision('{"decision":"skip"}')).toEqual({ decision: "skip" });
    expect(
      parseRoleplaySpontaneousDecision('{"decision":"send","messages":[" Hi ","Second"]}'),
    ).toEqual({ decision: "send", messages: ["Hi", "Second"] });
    for (const invalid of [
      "null",
      "[]",
      "prefix {}",
      '{"decision":"skip","messages":[]}',
      '{"decision":"send","messages":[]}',
      '{"decision":"send","messages":[" "]}',
      '{"decision":"send","messages":["1","2","3","4"]}',
      JSON.stringify({ decision: "send", messages: ["a".repeat(2001)] }),
      JSON.stringify({ decision: "send", messages: ["a"], toolCall: {} }),
      " ".repeat(8193),
    ])
      expect(parseRoleplaySpontaneousDecision(invalid)).toBeNull();
  });

  it("builds the same scoped character/history/continuity context without a fake user message", () => {
    const history = [
      {
        seq: 1,
        role: "user" as const,
        content: "See you tomorrow",
        createdAt: "2026-10-27T16:00:00Z",
      },
    ];
    const request = buildRoleplaySpontaneousRequest({
      character,
      history,
      temporal: { now: facts.now, timezone: facts.timezone },
    });
    expect(request.history).toEqual(history);
    expect(JSON.parse(request.prompt)).toEqual({
      purpose: "Decide whether a spontaneous message is warranted now; skipping is welcome.",
    });
    expect(request.activeLoreEntries).toEqual([]);
  });
});
