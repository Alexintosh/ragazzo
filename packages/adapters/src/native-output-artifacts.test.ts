import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishNativeOutput } from "./native-output-artifacts.js";
import type { RunContext } from "./run-context.js";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  persist: vi.fn(),
  owned: vi.fn(),
}));
vi.mock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: mocks.attach }));
vi.mock("./run-messages.js", () => ({
  persistMessageInTransaction: mocks.persist,
  isUniqueViolation: (error: { code?: string }) => error.code === "P2002",
}));

describe("native file publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owned.mockResolvedValue({ count: 1 });
    mocks.persist.mockResolvedValue({ eventSeq: 7, firstResponseRunId: "run" });
    mocks.attach.mockImplementation(async (_deps, input) =>
      input.onAttached(
        { $queryRaw: vi.fn(async () => []), run: { updateMany: mocks.owned } },
        {
          id: "artifact",
          mimeType: "text/plain",
          name: "report.txt",
          size: 2,
          version: 1,
          createdAt: new Date(0),
        },
      ),
    );
  });
  function setup() {
    const lookup = vi.fn().mockResolvedValue(null);
    const notify = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      deps: { prisma: { message: { findUnique: lookup } }, artifacts: {}, events: { notify } },
      run: { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
      thread: { id: "thread", groupId: null },
      context: { signal: new AbortController().signal },
      state: { reply: { publishedMidTurnUserMessage: false } },
    } as unknown as RunContext;
    return { ctx, lookup, notify };
  }
  const file = { id: "owned-run-file-event", path: "report.txt", bytes: new Uint8Array([1, 2]) };
  it("commits the file message with its artifact and checks the active lease", async () => {
    const { ctx, lookup, notify } = setup();
    await publishNativeOutput(ctx, file, { workerId: "worker", fence: 3 });
    expect(lookup).toHaveBeenCalledWith({
      where: {
        threadId_clientNonce: {
          threadId: "thread",
          clientNonce: "native-output:owned-run-file-event",
        },
      },
      select: { id: true },
    });
    expect(mocks.owned).toHaveBeenCalledWith({
      where: {
        id: "run",
        status: "running",
        leaseOwner: "worker",
        leaseFence: 3,
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      data: { leaseFence: 3 },
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.anything(),
      ctx.run,
      "bot",
      [expect.objectContaining({ kind: "file", artifactId: "artifact" })],
      undefined,
      "native-output:owned-run-file-event",
    );
    expect(notify).toHaveBeenCalledWith("thread", 7, "run");
    expect(ctx.state.reply.publishedMidTurnUserMessage).toBe(true);
  });
  it("deduplicates a cursor replay even from a continuation run", async () => {
    const { ctx, lookup } = setup();
    ctx.run.id = "continuation";
    lookup.mockResolvedValue({ id: "published" });
    await publishNativeOutput(ctx, file, { workerId: "worker", fence: 4 });
    expect(mocks.attach).not.toHaveBeenCalled();
  });
  it("does not publish files from an expired lease", async () => {
    const { ctx } = setup();
    mocks.owned.mockResolvedValue({ count: 0 });
    await expect(
      publishNativeOutput(ctx, file, { workerId: "old-worker", fence: 2 }),
    ).rejects.toThrow("lease expired");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
