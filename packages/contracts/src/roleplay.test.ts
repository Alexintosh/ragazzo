import { describe, expect, it } from "vitest";
import { BotSchema, CreateBotInput } from "./domain.js";
import {
  parseRoleplayCharacterJson,
  ROLEPLAY_IMPORT_MAX_BYTES,
  RoleplayCharacterSchema,
  RoleplayContinuitySchema,
} from "./roleplay.js";

const plain = {
  name: "Mira",
  description: "An explorer",
  personality: "Curious",
  scenario: "An island",
  first_mes: "Welcome",
  mes_example: "{{char}}: Hello",
};
describe("roleplay character imports", () => {
  it.each([undefined, "chara_card_v2", "chara_card_v3"])(
    "imports common card %s into one text-only shape",
    (spec) => {
      const imported = parseRoleplayCharacterJson(
        JSON.stringify(
          spec
            ? { spec, spec_version: spec === "chara_card_v3" ? "3.0" : "2.0", data: plain }
            : plain,
        ),
      );
      expect(imported.character).toMatchObject({
        name: "Mira",
        description: "An explorer",
        personality: "Curious",
        scenario: "An island",
        firstMessage: "Welcome",
        exampleDialogue: "{{char}}: Hello",
        lorebook: null,
      });
      expect(imported.warnings).toEqual([]);
    },
  );
  it("normalizes bounded lore and reports executable/unsupported extensions", () => {
    const imported = parseRoleplayCharacterJson(
      JSON.stringify({
        ...plain,
        extensions: { risuai: { triggerscript: ["untrusted"] } },
        character_book: {
          scan_depth: 4,
          token_budget: 1024,
          recursive_scanning: true,
          entries: [
            {
              keys: ["island"],
              secondary_keys: ["map"],
              content: "A hidden trail",
              enabled: true,
              selective: true,
              case_sensitive: true,
              position: "after_char",
              insertion_order: 8,
            },
          ],
        },
      }),
    );
    expect(imported.character.lorebook).toMatchObject({
      scanDepth: 4,
      tokenBudget: 1024,
      entries: [
        {
          keys: ["island"],
          secondaryKeys: ["map"],
          content: "A hidden trail",
          caseSensitive: true,
          insertionOrder: 8,
          position: "after_char",
        },
      ],
    });
    expect(imported.warnings.length).toBe(2);
    expect(JSON.stringify(imported.character)).not.toContain("untrusted");
  });
  it("keeps old cards unchanged and accepts only the supported conversation style extension", () => {
    const legacy = parseRoleplayCharacterJson(JSON.stringify(plain)).character;
    expect(legacy).not.toHaveProperty("conversationStyle");
    expect(RoleplayCharacterSchema.parse(legacy)).toEqual(legacy);
    for (const conversationStyle of ["chat", "narrative"] as const) {
      expect(
        parseRoleplayCharacterJson(JSON.stringify({ ...plain, conversationStyle })).character
          .conversationStyle,
      ).toBe(conversationStyle);
      const imported = parseRoleplayCharacterJson(
        JSON.stringify({
          spec: "chara_card_v2",
          data: { ...plain, extensions: { rakazo: { conversation_style: conversationStyle } } },
        }),
      );
      expect(imported.character.conversationStyle).toBe(conversationStyle);
      expect(imported.warnings).toEqual([]);
    }
    expect(
      parseRoleplayCharacterJson(
        JSON.stringify({
          ...plain,
          extensions: { rakazo: { conversation_style: "chat", script: "discard me" }, other: {} },
        }),
      ).warnings,
    ).toHaveLength(1);
    expect(() =>
      parseRoleplayCharacterJson(
        JSON.stringify({ ...plain, extensions: { rakazo: { conversation_style: "unknown" } } }),
      ),
    ).toThrow();
    expect(() =>
      parseRoleplayCharacterJson(JSON.stringify({ ...plain, conversationStyle: null })),
    ).toThrow();
  });
  it("supports Risu plain text aliases and lore", () => {
    expect(
      parseRoleplayCharacterJson(
        JSON.stringify({
          name: "Mira",
          desc: "Explorer",
          firstMessage: "Hi",
          exampleMessage: "Hello",
          globalLore: [
            { key: "trail, map", content: "A trail", alwaysActive: true, insertorder: 3 },
          ],
        }),
      ).character,
    ).toMatchObject({
      description: "Explorer",
      firstMessage: "Hi",
      lorebook: { entries: [{ keys: ["trail", "map"], constant: true, insertionOrder: 3 }] },
    });
  });
  it.each([
    "[]",
    "null",
    "{",
    JSON.stringify({ ...plain, description: 3 }),
    JSON.stringify({ ...plain, character_book: { scan_depth: 101 } }),
    JSON.stringify({ ...plain, description: "x".repeat(100_001) }),
    " ".repeat(ROLEPLAY_IMPORT_MAX_BYTES + 1),
  ])("rejects malformed or oversized input", (input) => {
    expect(() => parseRoleplayCharacterJson(input)).toThrow();
  });
});

describe("bounded story continuity contract", () => {
  const empty = { scene: "", relationship: "", sharedDetails: [], openThreads: [], callbacks: [] };
  it("accepts complete snapshots at field limits", () => {
    expect(
      RoleplayContinuitySchema.safeParse({
        scene: "s".repeat(800),
        relationship: "r".repeat(800),
        sharedDetails: Array(12).fill("d".repeat(400)),
        openThreads: Array(8).fill("t".repeat(400)),
        callbacks: Array(8).fill("c".repeat(400)),
      }).success,
    ).toBe(true);
  });
  it.each([
    { scene: "s".repeat(801) },
    { relationship: "r".repeat(801) },
    { sharedDetails: Array(13).fill("") },
    { sharedDetails: ["d".repeat(401)] },
    { openThreads: Array(9).fill("") },
    { openThreads: ["t".repeat(401)] },
    { callbacks: Array(9).fill("") },
    { callbacks: ["c".repeat(401)] },
    { callbacks: [1] },
    { extra: "unsupported" },
    {
      sharedDetails: Array(12).fill("界".repeat(400)),
      openThreads: Array(2).fill("界".repeat(400)),
    },
  ])("rejects out-of-contract snapshot %j", (overrides) => {
    expect(RoleplayContinuitySchema.safeParse({ ...empty, ...overrides }).success).toBe(false);
  });
  it("requires all fields", () => {
    expect(RoleplayContinuitySchema.safeParse({ scene: "" }).success).toBe(false);
  });
});
describe("roleplay creation contract", () => {
  const character = parseRoleplayCharacterJson(JSON.stringify(plain)).character;
  it("defaults old payloads to agent and requires a character only for roleplay", () => {
    expect(CreateBotInput.parse({ name: "Agent" }).botKind).toBe("agent");
    expect(BotSchema.shape.roleplayCharacter.parse(undefined)).toBeNull();
    expect(CreateBotInput.safeParse({ name: "Mira", botKind: "roleplay" }).success).toBe(false);
    expect(CreateBotInput.safeParse({ name: "Mira", roleplayCharacter: character }).success).toBe(
      false,
    );
    expect(
      CreateBotInput.safeParse({ name: "Mira", botKind: "roleplay", roleplayCharacter: character })
        .success,
    ).toBe(true);
  });
  it.each([
    { runtimeKind: "codex" },
    { executionTarget: "host" },
    { executionTarget: "default" },
    { registeredHostId: "host" },
    { projectPath: "/private" },
    { fleetManagement: true },
  ])("rejects agent execution/configuration %j", (settings) => {
    expect(
      CreateBotInput.safeParse({
        name: "Mira",
        botKind: "roleplay",
        roleplayCharacter: character,
        ...settings,
      }).success,
    ).toBe(false);
  });
});

describe("spontaneous settings and dated continuity", () => {
  const legacy = {
    scene: "",
    relationship: "New acquaintances",
    sharedDetails: [],
    openThreads: [],
    callbacks: [],
  };
  const event = {
    id: "cafe",
    description: "Meet at the cafe",
    date: "2026-10-30",
    status: "planned",
    sourceMessageSeq: 2,
    sourceMessageAt: "2026-10-29T10:00:00Z",
  };

  it("preserves legacy continuity and optional settings without an implicit opt-in", () => {
    expect(RoleplayContinuitySchema.parse(legacy)).toEqual(legacy);
    const character = parseRoleplayCharacterJson(JSON.stringify(plain)).character;
    expect(RoleplayCharacterSchema.parse(character)).not.toHaveProperty("spontaneous");
    expect(
      RoleplayCharacterSchema.parse({
        ...character,
        spontaneous: { enabled: true, frequency: "gentle", allowLateNight: false },
      }).spontaneous?.enabled,
    ).toBe(true);
  });

  it.each([undefined, "chara_card_v2", "chara_card_v3"])(
    "cannot activate messaging through imported %s cards",
    (spec) => {
      const data = {
        ...plain,
        spontaneous: { enabled: true, frequency: "frequent", allowLateNight: true },
        extensions: { rakazo: { conversation_style: "chat", spontaneous: { enabled: true } } },
      };
      const imported = parseRoleplayCharacterJson(JSON.stringify(spec ? { spec, data } : data));
      expect(imported.character).not.toHaveProperty("spontaneous");
      expect(imported.character.conversationStyle).toBe("chat");
    },
  );

  it("bounds numeric character state and dated provenance while keeping descriptions", () => {
    const continuity = {
      ...legacy,
      relationshipState: { warmth: 40, intimacy: 5, love: 0 },
      datedEvents: [event],
    };
    expect(RoleplayContinuitySchema.parse(continuity)).toEqual(continuity);
    for (const invalid of [
      { relationshipState: { warmth: 101, intimacy: 0, love: 0 } },
      { relationshipState: { warmth: 0, intimacy: -1, love: 0 } },
      { relationshipState: { warmth: 0, intimacy: 0, love: 0.5 } },
      { datedEvents: Array(13).fill(event) },
      { datedEvents: [{ ...event, date: "2026-02-30" }] },
      { datedEvents: [{ ...event, sourceMessageAt: "tomorrow" }] },
      { datedEvents: [{ ...event, status: "happened-because-date-passed" }] },
      { datedEvents: [{ ...event, sourceMessageSeq: -1 }] },
    ])
      expect(RoleplayContinuitySchema.safeParse({ ...legacy, ...invalid }).success).toBe(false);
  });
});
