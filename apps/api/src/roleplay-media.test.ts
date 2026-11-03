import type { RoleplayCharacter } from "@rakazo/contracts";
import { roleplayStoryState } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { createOwnedArtifact } from "./artifacts.js";
import {
  assertRoleplayAlbum,
  importRoleplayMedia,
  loadRoleplayMedia,
  updateRoleplayStoryMode,
} from "./roleplay-media.js";
import type { RouterDeps } from "./router.js";

vi.mock("./artifacts.js", () => ({
  createOwnedArtifact: vi.fn(async (_deps, _actor, input) => ({ id: "image", ...input })),
}));
const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const state = roleplayStoryState(null, { threadId: "story", botId: "bot", historyGeneration: 0 });
  const thread = {
    id: "story",
    spaceId: "space",
    userId: "owner",
    groupId: null,
    externalConversationId: null,
    roleplayState: state as unknown,
    historyCompactionGeneration: 0,
    nextMessageSeq: 2,
  };
  const bot = { id: "bot", botKind: "roleplay", thread };
  const user = vi.fn(async () => ({ roleplayEnabled: true }));
  const active = vi.fn(async (): Promise<object | null> => null);
  const images = vi.fn(async () => [] as Array<{ id: string; mimeType: string; createdAt: Date }>);
  const update = vi.fn(async ({ data }) => {
    thread.roleplayState = data.roleplayState;
    return thread;
  });
  const db = {
    bot: { findFirst: vi.fn(async () => bot) },
    user: { findUnique: user },
    artifact: { findMany: images },
    run: { findFirst: active },
    thread: { update },
    $queryRaw: vi.fn(async () => []),
  };
  const deps = {
    prisma: { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) },
    env: {},
    remoteConnectors: {
      resolveHostname: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
      fetch: vi.fn(
        async () =>
          new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
            headers: { "content-type": "image/png" },
          }),
      ),
    },
  } as unknown as RouterDeps;
  return { deps, bot, thread, user, active, images, update };
}
describe("roleplay media", () => {
  it("toggles only this story with optimistic concurrency and preserves memory", async () => {
    const f = fixture();
    const before = await loadRoleplayMedia(f.deps, actor, "bot");
    const after = await updateRoleplayStoryMode(f.deps, actor, {
      botId: "bot",
      enabled: true,
      historyGeneration: before.historyGeneration,
      expectedRevision: before.revision,
    });
    expect(after.storyMode).toBe(true);
    expect(after.revision).not.toBe(before.revision);
    expect(f.thread.roleplayState).toMatchObject({ media: { storyMode: true, revision: 1 } });
    await expect(
      updateRoleplayStoryMode(f.deps, actor, {
        botId: "bot",
        enabled: false,
        historyGeneration: before.historyGeneration,
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow("conversation changed");
  });
  it("rejects active turns, disabled accounts and non-direct conversations", async () => {
    const f = fixture();
    const before = await loadRoleplayMedia(f.deps, actor, "bot");
    f.active.mockResolvedValue({ id: "run" });
    await expect(
      updateRoleplayStoryMode(f.deps, actor, {
        botId: "bot",
        enabled: true,
        historyGeneration: 0,
        expectedRevision: before.revision,
      }),
    ).rejects.toThrow("current reply");
    expect(f.update).not.toHaveBeenCalled();
    f.bot.botKind = "agent";
    await expect(loadRoleplayMedia(f.deps, actor, "bot")).rejects.toThrow("direct roleplay");
    f.user.mockResolvedValue({ roleplayEnabled: false });
    await expect(loadRoleplayMedia(f.deps, actor, "bot")).rejects.toThrow("not enabled");
  });
  it("validates every album image against direct bot ownership and raster types", async () => {
    const f = fixture();
    const character = { media: { album: [{ artifactId: "image" }] } } as RoleplayCharacter;
    await expect(assertRoleplayAlbum(f.deps, actor, "bot", character)).rejects.toThrow("belong");
    f.images.mockResolvedValue([{ id: "image", mimeType: "image/png", createdAt: new Date() }]);
    await assertRoleplayAlbum(f.deps, actor, "bot", character);
    expect(f.images).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        botId: "bot",
        userId: "owner",
        spaceId: "space",
        groupId: null,
        uploadThreadId: null,
      }),
    });
    await expect(assertRoleplayAlbum(f.deps, actor, null, character)).rejects.toThrow(
      "Save the character",
    );
  });
  it("imports raster bytes into owned artifacts without retaining the source URL", async () => {
    const f = fixture();
    await importRoleplayMedia(f.deps, actor, {
      botId: "bot",
      url: "https://images.example.test/photo.png",
    });
    expect(createOwnedArtifact).toHaveBeenLastCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        botId: "bot",
        mimeType: "image/png",
        contentBase64: "iVBORw0KGgo=",
      }),
    );
    expect(vi.mocked(createOwnedArtifact).mock.calls.at(-1)?.[2]).not.toHaveProperty("url");
  });
  it.each([
    "http://127.0.0.1/image",
    "http://169.254.169.254/image",
    "https://user:pass@example.test/image",
  ])("refuses unsafe source %s", async (url) => {
    const f = fixture();
    await expect(importRoleplayMedia(f.deps, actor, { botId: "bot", url })).rejects.toThrow();
    expect(f.deps.remoteConnectors!.fetch).not.toHaveBeenCalled();
  });
  it("checks redirect destinations and refuses false image content types", async () => {
    const f = fixture();
    vi.mocked(f.deps.remoteConnectors!.fetch!).mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/image" } }),
    );
    await expect(
      importRoleplayMedia(f.deps, actor, { botId: "bot", url: "https://images.example.test/a" }),
    ).rejects.toThrow();
    expect(f.deps.remoteConnectors!.fetch).toHaveBeenCalledTimes(1);
    vi.mocked(f.deps.remoteConnectors!.fetch!).mockResolvedValue(
      new Response("<html>", { headers: { "content-type": "image/png" } }),
    );
    await expect(
      importRoleplayMedia(f.deps, actor, { botId: "bot", url: "https://images.example.test/a" }),
    ).rejects.toThrow("supported image");
  });
});
