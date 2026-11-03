import { describe, expect, it } from "vitest";
import { RoleplayMediaSettingsSchema, RoleplayMediaStateSchema } from "./roleplay.js";

const entry = { id: "forest", artifactId: "image", description: "A forest", enabled: true };
const settings = {
  enabled: true,
  allowSpontaneous: false,
  normalIntervalTurns: 4,
  storyIntervalTurns: 1,
  album: [entry],
};
describe("roleplay media contracts", () => {
  it("accepts a bounded album and rejects duplicate references", () => {
    expect(RoleplayMediaSettingsSchema.parse(settings)).toEqual(settings);
    for (const album of [
      [entry, entry],
      [entry, { ...entry, id: "other" }],
      Array.from({ length: 33 }, (_, index) => ({
        ...entry,
        id: String(index),
        artifactId: String(index),
      })),
    ])
      expect(RoleplayMediaSettingsSchema.safeParse({ ...settings, album }).success).toBe(false);
  });
  it("bounds intervals, descriptors and ledger size", () => {
    expect(
      RoleplayMediaSettingsSchema.safeParse({ ...settings, normalIntervalTurns: 0 }).success,
    ).toBe(false);
    expect(
      RoleplayMediaSettingsSchema.safeParse({ ...settings, storyIntervalTurns: 101 }).success,
    ).toBe(false);
    expect(
      RoleplayMediaSettingsSchema.safeParse({
        ...settings,
        album: [{ ...entry, description: " " }],
      }).success,
    ).toBe(false);
    const state = {
      storyMode: false,
      scene: "",
      revision: 0,
      turn: 2,
      lastImageTurn: 3,
      sentImageIds: [],
    };
    expect(RoleplayMediaStateSchema.safeParse(state).success).toBe(false);
    expect(
      RoleplayMediaStateSchema.safeParse({
        ...state,
        lastImageTurn: null,
        sentImageIds: Array(33).fill("id"),
      }).success,
    ).toBe(false);
  });
});
