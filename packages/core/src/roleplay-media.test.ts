import type { RoleplayCharacter } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { roleplayStoryState } from "./roleplay.js";
import {
  buildRoleplayDirectionRequest,
  buildRoleplayMediaContext,
  parseRoleplayDirection,
  roleplayMediaState,
  selectRoleplayImage,
} from "./roleplay-media.js";

const media = {
  enabled: true,
  allowSpontaneous: true,
  normalIntervalTurns: 6,
  storyIntervalTurns: 2,
  album: [
    { id: "forest", artifactId: "art-forest", description: "A fox in a forest", enabled: true },
    {
      id: "castle",
      artifactId: "art-castle",
      description: "A castle",
      scene: "castle",
      enabled: true,
    },
    { id: "off", artifactId: "art-off", description: "Disabled", enabled: false },
  ],
};
const character = {
  name: "Story fox",
  description: "A friendly narrator",
  media,
} as RoleplayCharacter;
const direction = { storyMode: false, scene: "forest", imageId: "castle", imageRequested: false };

describe("roleplay media direction", () => {
  it("validates exact bounded controls without extracting JSON from prose", () => {
    expect(parseRoleplayDirection(JSON.stringify(direction))).toEqual(direction);
    for (const raw of [
      "hi",
      `prefix ${JSON.stringify(direction)}`,
      JSON.stringify({ ...direction, extra: true }),
      JSON.stringify({ ...direction, scene: "x".repeat(801) }),
      JSON.stringify({ ...direction, imageId: 42 }),
    ])
      expect(parseRoleplayDirection(raw)).toBeNull();
  });
  it("enforces catalog, cadence, spontaneous preference, repeats and story scene transitions", () => {
    const state = { ...roleplayMediaState(null), turn: 5, lastImageTurn: 4, scene: "forest" };
    expect(selectRoleplayImage({ character, state, direction })).toBeUndefined();
    expect(
      selectRoleplayImage({ character, state, direction: { ...direction, storyMode: true } })?.id,
    ).toBe("castle");
    expect(
      selectRoleplayImage({
        character,
        state,
        direction: { ...direction, storyMode: true, scene: "castle" },
      })?.id,
    ).toBe("castle");
    for (const imageId of ["off", "invented", "art-castle"])
      expect(
        selectRoleplayImage({
          character,
          state,
          direction: { ...direction, imageId, imageRequested: true },
        }),
      ).toBeUndefined();
    const sent = { ...state, sentImageIds: ["castle"] };
    expect(
      selectRoleplayImage({ character, state: sent, direction: { ...direction, storyMode: true } }),
    ).toBeUndefined();
    expect(
      selectRoleplayImage({
        character,
        state: sent,
        direction: { ...direction, imageRequested: true },
      })?.id,
    ).toBe("castle");
    expect(
      selectRoleplayImage({
        character: { ...character, media: { ...media, allowSpontaneous: false } },
        state,
        direction: { ...direction, imageRequested: true },
        spontaneous: true,
      }),
    ).toBeUndefined();
    expect(
      selectRoleplayImage({
        character: { ...character, media: { ...media, enabled: false } },
        state,
        direction: { ...direction, imageRequested: true },
      }),
    ).toBeUndefined();
  });
  it("does not tie story illustrations to relationship scores and keeps scope durable", () => {
    const state = {
      ...roleplayMediaState(null),
      storyMode: true,
      scene: "forest",
      turn: 12,
      revision: 8,
      lastImageTurn: 10,
      sentImageIds: ["forest"],
    };
    const saved = {
      ...roleplayStoryState(null, { threadId: "story", botId: "fox", historyGeneration: 0 }),
      summary: "Earlier story",
      media: state,
    };
    expect(
      roleplayStoryState(saved, { threadId: "story", botId: "fox", historyGeneration: 0 }).media,
    ).toEqual(state);
    expect(
      roleplayStoryState(saved, { threadId: "other", botId: "fox", historyGeneration: 0 }).media,
    ).toBeUndefined();
    expect(
      selectRoleplayImage({ character, state, direction: { ...direction, storyMode: true } })?.id,
    ).toBe("castle");
    const request = buildRoleplayDirectionRequest({
      character,
      state,
      history: [],
      prompt: "Tell me an adventure",
      summary: "",
    });
    expect(JSON.parse(request.prompt).latestPlayerMessage).toBe("Tell me an adventure");
    expect(request.history).toEqual([]);
    expect(buildRoleplayMediaContext(state, media.album[0])).toContain(media.album[0]!.description);
    expect(buildRoleplayMediaContext(state)).toContain("no image attachment");
  });
  it("bounds corrupt state independently of existing story memory", () => {
    expect(roleplayMediaState({ ...roleplayMediaState(null), scene: "x".repeat(801) })).toEqual(
      roleplayMediaState(null),
    );
    expect(roleplayMediaState({ ...roleplayMediaState(null), lastImageTurn: 2 })).toEqual(
      roleplayMediaState(null),
    );
  });
});
