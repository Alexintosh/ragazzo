import { describe, expect, it } from "vitest";
import {
  ConversationEngineItemNameSchema,
  ConversationEngineItemSchema,
  ConversationEngineSettingsSchema,
} from "./conversation-engine.js";

describe("conversation engine request settings", () => {
  it("reads operator presets without applying the native write-name restriction", () => {
    const name = "Long preset ".repeat(10);
    expect(
      ConversationEngineItemSchema.parse({
        id: null,
        kind: "item",
        name,
        source: "preset",
        createdAt: null,
      }).name,
    ).toBe(name);
    expect(ConversationEngineItemNameSchema.safeParse(name).success).toBe(false);
  });
  it("accepts the native Unicode character boundary and normalizes line values", () => {
    expect(ConversationEngineSettingsSchema.parse({ outfit: "😀".repeat(64) }).outfit).toHaveLength(
      128,
    );
    expect(
      ConversationEngineSettingsSchema.parse({
        promptTraits: [{ tag: "tone", text: " Friendly " }],
      }),
    ).toEqual({ promptTraits: [{ tag: "tone", text: "Friendly" }] });
    expect(ConversationEngineSettingsSchema.safeParse({ outfit: "😀".repeat(65) }).success).toBe(
      false,
    );
  });

  it("rejects unsupported generation configuration and malformed native defaults", () => {
    for (const value of [
      { temperature: 0.5 },
      { maxTokens: 100 },
      { tier: "unknown-tier" },
      { outfit: "line\nbreak" },
      { promptTraits: [{ tag: "Uppercase", text: "Friendly" }] },
      { promptTraits: [{ tag: "tone", text: "line\u2028break" }] },
      { promptTraits: Array.from({ length: 9 }, () => ({ tag: "tone", text: "Friendly" })) },
      { memoryScope: "global" },
      { affinityScope: ["made_up"] },
    ])
      expect(ConversationEngineSettingsSchema.safeParse(value).success).toBe(false);
  });
});
