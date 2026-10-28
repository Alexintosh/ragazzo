import { describe, expect, it } from "vitest";
import { BotSchema, CreateBotInput } from "./domain.js";
import { parseRoleplayCharacterJson, ROLEPLAY_IMPORT_MAX_BYTES } from "./roleplay.js";

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
