import type { MessageBlock, RoleplayCharacter } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { validateRoleplayMediaDelivery } from "./roleplay-media.js";

const media = {
  enabled: true,
  allowSpontaneous: true,
  normalIntervalTurns: 4,
  storyIntervalTurns: 1,
  album: [{ id: "forest", artifactId: "image", description: "A forest", enabled: true }],
};
const character: RoleplayCharacter = {
  name: "Guide",
  description: "",
  personality: "",
  scenario: "",
  firstMessage: "",
  exampleDialogue: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  alternateGreetings: [],
  lorebook: null,
  media,
};
const prior = {
  storyMode: false,
  scene: "Forest",
  revision: 2,
  turn: 2,
  lastImageTurn: null,
  sentImageIds: [] as string[],
};
const next = { ...prior, revision: 3, turn: 3, lastImageTurn: 3, sentImageIds: ["forest"] };
function fixture() {
  const bot = { botKind: "roleplay", roleplayCharacter: structuredClone(character) };
  const thread = {
    historyCompactionGeneration: 1,
    roleplayState: { media: structuredClone(prior) },
  };
  const user = { roleplayEnabled: true };
  const artifacts = vi.fn(async () => [{ id: "image", mimeType: "image/png" }]);
  const tx = {
    bot: { findFirst: async () => bot },
    thread: { findFirst: async () => thread },
    user: { findUnique: async () => user },
    artifact: { findMany: artifacts },
  } as unknown as Prisma.TransactionClient;
  const input = {
    botId: "bot",
    threadId: "thread",
    spaceId: "space",
    userId: "user",
    spontaneous: false,
    roleplayState: { media: next },
    roleplayMediaGuard: {
      revision: 2,
      historyGeneration: 1,
      characterMedia: JSON.stringify(media),
      imageRequested: false,
    },
    blocks: [
      { kind: "text", text: "Here is the forest" },
      { kind: "image", artifactId: "image", mimeType: "image/png", name: "forest.png" },
    ] as MessageBlock[],
  };
  return { tx, input, bot, thread, user, artifacts };
}
describe("roleplay media finalization validation", () => {
  it("validates current ownership, catalog mapping and durable state before delivery", async () => {
    const f = fixture();
    expect(await validateRoleplayMediaDelivery(f.tx, f.input)).toEqual({
      suppress: false,
      roleplayState: f.input.roleplayState,
    });
    expect(f.artifacts).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ["image"] },
        botId: "bot",
        spaceId: "space",
        userId: "user",
        groupId: null,
        uploadThreadId: null,
      }),
    });
  });
  it.each(["revision", "generation", "album", "account", "spontaneous", "artifact", "ledger"])(
    "suppresses entire image reply on %s change",
    async (change) => {
      const f = fixture();
      if (change === "revision") f.thread.roleplayState.media.revision++;
      if (change === "generation") f.thread.historyCompactionGeneration++;
      if (change === "album") f.bot.roleplayCharacter.media!.album[0]!.enabled = false;
      if (change === "account") f.user.roleplayEnabled = false;
      if (change === "spontaneous") {
        f.input.spontaneous = true;
        f.bot.roleplayCharacter.media!.allowSpontaneous = false;
      }
      if (change === "artifact") f.artifacts.mockResolvedValue([]);
      if (change === "ledger") f.input.roleplayState.media = { ...next, sentImageIds: [] };
      expect((await validateRoleplayMediaDelivery(f.tx, f.input)).suppress).toBe(true);
    },
  );
  it.each([
    { requested: true, spontaneous: false, suppress: false },
    { requested: false, spontaneous: false, suppress: true },
    { requested: true, spontaneous: true, suppress: true },
  ])(
    "handles repeated image with explicit request=$requested spontaneous=$spontaneous",
    async ({ requested, spontaneous, suppress }) => {
      const f = fixture();
      f.thread.roleplayState.media.sentImageIds = ["forest"];
      Object.assign(f.thread.roleplayState.media, { lastImageTurn: 2 });
      f.input.spontaneous = spontaneous;
      f.input.roleplayMediaGuard.imageRequested = requested;
      const result = await validateRoleplayMediaDelivery(f.tx, f.input);
      expect(result.suppress).toBe(suppress);
      if (!suppress) expect(result.roleplayState).toEqual(f.input.roleplayState);
    },
  );
  it("keeps latest media on stale text-only replies", async () => {
    const f = fixture();
    f.thread.roleplayState.media.revision = 4;
    f.input.blocks = [{ kind: "text", text: "Hello" }];
    expect(await validateRoleplayMediaDelivery(f.tx, f.input)).toEqual({
      suppress: false,
      roleplayState: { media: f.thread.roleplayState.media },
    });
  });
});
