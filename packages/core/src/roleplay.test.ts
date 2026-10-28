import type { RoleplayCharacter, RoleplayLorebookEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRoleplayPrompt,
  ROLEPLAY_CHAT_INSTRUCTION,
  ROLEPLAY_NARRATIVE_INSTRUCTION,
  roleplayMacros,
  roleplayMemoryWindow,
  roleplayStoryState,
  roleplayTokens,
  selectRoleplayLore,
} from "./roleplay.js";

const entry = (overrides: Partial<RoleplayLorebookEntry> = {}): RoleplayLorebookEntry => ({
  keys: ["forest"],
  secondaryKeys: [],
  content: "The forest is ancient.",
  enabled: true,
  constant: false,
  selective: false,
  caseSensitive: false,
  insertionOrder: 0,
  position: "before_char",
  ...overrides,
});
const character: RoleplayCharacter = {
  name: "Aria",
  description: "A wandering cartographer.",
  personality: "Curious",
  scenario: "{{char}} meets {{user}} by the gate.",
  exampleDialogue: "{{char}}: Follow the stars.",
  firstMessage: "The map unfolds.",
  systemPrompt: "Use descriptive dialogue.",
  postHistoryInstructions: "Stay in scene.",
  alternateGreetings: [],
  lorebook: {
    name: "World",
    description: "",
    scanDepth: 2,
    tokenBudget: 200,
    entries: [entry()],
  },
};
const scope = { threadId: "story-a", botId: "aria", historyGeneration: 0 };

describe("roleplay prompt engine", () => {
  it("selects chat instruction only explicitly and keeps continuity separate from examples", () => {
    const continuity = {
      scene: "Still messaging",
      relationship: "New acquaintances",
      sharedDetails: ["Player prefers tea"],
      openThreads: ["A cafe was suggested, not agreed"],
      callbacks: [],
    };
    const legacy = buildRoleplayPrompt({ character, history: [], prompt: "Hi" });
    const narrative = buildRoleplayPrompt({
      character: { ...character, conversationStyle: "narrative" },
      history: [],
      prompt: "Hi",
    });
    const chat = buildRoleplayPrompt({
      character: { ...character, conversationStyle: "chat" },
      history: [],
      prompt: "Hi",
      continuity,
    });
    expect(legacy.instructions).toBe(narrative.instructions);
    expect(legacy.instructions.startsWith(ROLEPLAY_NARRATIVE_INSTRUCTION)).toBe(true);
    expect(legacy.instructions).not.toContain(ROLEPLAY_CHAT_INSTRUCTION);
    expect(chat.instructions).toContain(ROLEPLAY_CHAT_INSTRUCTION);
    expect(chat.instructions).toContain(JSON.stringify(continuity));
    expect(legacy.instructions).not.toContain(JSON.stringify(continuity));
    expect(roleplayTokens(chat.instructions)).toBeGreaterThan(roleplayTokens(legacy.instructions));
  });
  it("keeps character, scene, example dialogue and narrative history distinct", () => {
    const history = [{ seq: 1, role: "assistant" as const, content: "Welcome to the forest." }];
    const prompt = buildRoleplayPrompt({
      character,
      history,
      prompt: "I enter.",
      summary: "We agreed to travel together.",
    });
    expect(prompt.history).toEqual(history);
    expect(prompt.instructions).toContain("Aria meets Player by the gate.");
    expect(prompt.instructions).toContain(
      "Example dialogue (style examples, not events in this story):\nAria: Follow the stars.",
    );
    expect(prompt.instructions).toContain("We agreed to travel together.");
    expect(prompt.instructions.indexOf("The forest is ancient.")).toBeLessThan(
      prompt.instructions.indexOf("Character:\nAria"),
    );
    expect(prompt.prompt).toBe("I enter.");
  });

  it("supports literal, case-sensitive, constant and selective lore without recursive triggers", () => {
    const book = {
      ...character,
      lorebook: {
        ...character.lorebook!,
        entries: [
          entry({ keys: ["Forest"], caseSensitive: true }),
          entry({ content: "A moonstone lies here.", constant: true, insertionOrder: 1 }),
          entry({ keys: ["moonstone"], content: "Should not recurse", insertionOrder: 2 }),
          entry({
            selective: true,
            secondaryKeys: ["night"],
            content: "At night owls gather.",
            position: "after_char",
            insertionOrder: 3,
          }),
          entry({ constant: true, enabled: false, content: "Disabled" }),
          entry({ keys: [".*"], content: "Regex is never evaluated" }),
        ],
      },
    };
    const selected = selectRoleplayLore(book, [
      { seq: 0, role: "user", content: "The forest at night" },
    ]);
    expect(selected.activeEntries).toEqual([1, 3]);
    expect(selected.after).toEqual(["At night owls gather."]);
  });

  it("uses scan depth, stable insertion order and a shared bounded lore budget", () => {
    const book = {
      ...character,
      lorebook: {
        ...character.lorebook!,
        scanDepth: 1,
        tokenBudget: 10,
        entries: [
          entry({ constant: true, content: "123456789", insertionOrder: 2 }),
          entry({ content: "old lore", insertionOrder: 0 }),
          entry({ constant: true, content: "abcdefghij", insertionOrder: 1 }),
          entry({
            constant: true,
            content: "This will not fit inside the remaining budget.",
            insertionOrder: 3,
          }),
        ],
      },
    };
    const selected = selectRoleplayLore(book, [
      { seq: 0, role: "user", content: "forest" },
      { seq: 1, role: "assistant", content: "a gate" },
    ]);
    expect(selected.activeEntries).toEqual([2, 0]);
    expect(selected.tokens).toBeLessThanOrEqual(10);
    expect(selectRoleplayLore(book, [], "Player", 0).activeEntries).toEqual([]);
  });

  it("does not interpret macro scripts or expand arbitrary variables", () => {
    expect(roleplayMacros("{{char}} {{user}} {{exec::rm -rf /}} {{secret}}", "Aria")).toBe(
      "Aria Player {{exec::rm -rf /}} {{secret}}",
    );
  });
});

describe("story memory isolation", () => {
  it("preserves legacy state when continuity is absent or independently invalid", () => {
    const state = {
      ...roleplayStoryState(null, scope),
      summary: "An established event",
      summarizedUpToSeq: 3,
      turnCount: 2,
      retainedInputs: [{ seq: 2, role: "user" as const, content: "A queued input" }],
    };
    expect(roleplayStoryState(state, scope)).toEqual(state);
    for (const continuity of [null, {}, { scene: "x".repeat(801) }]) {
      expect(roleplayStoryState({ ...state, continuity }, scope)).toEqual(state);
    }
    const continuity = {
      scene: "A cafe",
      relationship: "Friends",
      sharedDetails: ["Tea"],
      openThreads: [],
      callbacks: [],
    };
    const restored = roleplayStoryState({ ...state, continuity }, scope);
    expect(restored.continuity).toEqual(continuity);
    continuity.sharedDetails.push("Later mutation");
    expect(restored.continuity?.sharedDetails).toEqual(["Tea"]);
    for (const changed of [{ threadId: "story-b" }, { botId: "other" }, { historyGeneration: 1 }])
      expect(roleplayStoryState(restored, { ...scope, ...changed }).continuity).toBeUndefined();
  });
  it("accepts only the exact bot, thread and history generation", () => {
    const state = {
      ...roleplayStoryState(null, scope),
      summary: "Private story event",
      summarizedUpToSeq: 4,
      turnCount: 2,
    };
    expect(roleplayStoryState(state, scope).summary).toBe("Private story event");
    for (const changed of [{ threadId: "story-b" }, { botId: "other" }, { historyGeneration: 1 }])
      expect(roleplayStoryState(state, { ...scope, ...changed }).summary).toBe("");
    expect(roleplayStoryState({ ...state, summary: "x".repeat(16_001) }, scope).summary).toBe("");
  });

  it("retains recent dialogue verbatim and explicitly identifies older memory input", () => {
    const history = Array.from({ length: 5 }, (_, seq) => ({
      seq,
      role: "user" as const,
      content: `Turn ${seq}: ${"x".repeat(30)}`,
    }));
    const window = roleplayMemoryWindow(history, 45);
    expect(window.older.concat(window.recent)).toEqual(history);
    expect(window.recent.map((message) => message.seq)).toEqual([3, 4]);
    expect(
      window.recent.reduce((sum, message) => sum + roleplayTokens(message.content) + 8, 0),
    ).toBeLessThanOrEqual(45);
    expect(roleplayMemoryWindow(history, 0).older).toEqual(history);
  });
});
