import { RoleplayContinuitySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRoleplayContinuityRequest,
  buildRoleplayRelationshipContext,
  parseRoleplayContinuity,
  splitRoleplayChatMessages,
} from "./roleplay-continuity.js";

const snapshot = {
  scene: "Messaging before a meeting",
  relationship: "New acquaintances",
  sharedDetails: ["Player prefers tea"],
  openThreads: ["A cafe was suggested"],
  callbacks: [],
};

describe("relationship reply context", () => {
  it("changes each dimension independently and includes the supplied values", () => {
    const low = { warmth: 0, intimacy: 0, love: 0 };
    const baseline = buildRoleplayRelationshipContext(low).split("\n");
    for (const [index, field] of ["warmth", "intimacy", "love"].entries()) {
      const changed = buildRoleplayRelationshipContext({ ...low, [field]: 100 }).split("\n");
      expect(changed[index + 1]).not.toBe(baseline[index + 1]);
      expect(changed[index + 1]).toContain("100/100");
      expect(changed.filter((_, line) => line !== index + 1)).toEqual(
        baseline.filter((_, line) => line !== index + 1),
      );
    }
  });
});

describe("continuity extraction contract", () => {
  it("accepts complete raw and fenced JSON without accepting surrounding prose", () => {
    const json = JSON.stringify(snapshot);
    for (const text of [
      json,
      `\n ${json}\n`,
      `\`\`\`json\n${json}\n\`\`\``,
      `\`\`\`\n${json}\n\`\`\``,
    ]) {
      expect(parseRoleplayContinuity(text)).toEqual(snapshot);
    }
    for (const text of [
      "",
      "null",
      "[]",
      "{",
      `${json}\nExtra`,
      `Here:\n${json}`,
      JSON.stringify({ ...snapshot, extra: true }),
      " ".repeat(16_385),
    ]) {
      expect(parseRoleplayContinuity(text)).toBeNull();
    }
  });

  it("rejects oversized and incomplete snapshots", () => {
    expect(
      parseRoleplayContinuity(JSON.stringify({ ...snapshot, callbacks: Array(9).fill("x") })),
    ).toBeNull();
    expect(parseRoleplayContinuity(JSON.stringify({ scene: "Missing fields" }))).toBeNull();
    expect(
      RoleplayContinuitySchema.safeParse(parseRoleplayContinuity(JSON.stringify(snapshot))).success,
    ).toBe(true);
  });

  it("keeps supplied story data in a bounded JSON envelope and includes the latest input and reply", () => {
    const messages = Array.from({ length: 50 }, (_, seq) => ({
      seq,
      role: seq % 2 ? ("assistant" as const) : ("user" as const),
      content: `${seq} ${"界".repeat(3_000)}`,
    }));
    const request = buildRoleplayContinuityRequest({
      current: snapshot,
      summary: "s".repeat(20_000),
      messages,
    });
    const data = JSON.parse(request.prompt);
    expect(data.priorContinuity).toEqual(snapshot);
    expect(new TextEncoder().encode(data.storySummary).length).toBeLessThanOrEqual(16_000);
    expect(data.recentMessages.map((message: { seq: number }) => message.seq).slice(-2)).toEqual([
      48, 49,
    ]);
    expect(data.recentMessages.length).toBeLessThanOrEqual(20);
    expect(
      data.recentMessages.reduce(
        (sum: number, message: { content: string }) =>
          sum + new TextEncoder().encode(message.content).length,
        0,
      ),
    ).toBeLessThanOrEqual(24_000);
    expect(request.instructions).not.toContain(snapshot.scene);
    expect(messages).toHaveLength(50);
    expect(buildRoleplayContinuityRequest({ messages: [] }).prompt).toBe(
      JSON.stringify({ priorContinuity: null, storySummary: "", recentMessages: [] }),
    );
  });
  it("preserves actual attachment metadata separately from dialogue within the excerpt byte limit", () => {
    const image = { description: "森".repeat(800) };
    const messages = Array.from({ length: 20 }, (_, seq) => ({
      seq,
      role: "assistant" as const,
      content: `Scene ${seq} ${"界".repeat(2_000)}`,
      image,
    }));
    const data = JSON.parse(buildRoleplayContinuityRequest({ messages }).prompt);
    expect(data.recentMessages.at(-1)).toMatchObject({ seq: 19, image });
    expect(
      data.recentMessages.every(
        (message: { content: string }) => !message.content.includes("[Shared image:"),
      ),
    ).toBe(true);
    expect(
      data.recentMessages.reduce(
        (bytes: number, message: { content: string; image: unknown }) =>
          bytes +
          new TextEncoder().encode(message.content).length +
          new TextEncoder().encode(JSON.stringify(message.image)).length,
        0,
      ),
    ).toBeLessThanOrEqual(24_000);
  });
});

describe("bounded chat message splitting", () => {
  it.each([
    ["", []],
    [" \n ", []],
    ["One reply", ["One reply"]],
    ["One\nline", ["One\nline"]],
    ["One\n\nTwo", ["One", "Two"]],
    ["One\r\n \r\nTwo\n\nThree\n\nFour", ["One", "Two", "Three\n\nFour"]],
    ["  One\n\n\nTwo\n\nThree  ", ["One", "Two", "Three"]],
  ])("preserves all non-delimiter content in at most three messages", (text, expected) => {
    expect(splitRoleplayChatMessages(text as string)).toEqual(expected);
  });
});
