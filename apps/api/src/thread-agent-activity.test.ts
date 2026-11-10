import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@rakazo/db";
import { loadThreadAgentActivity } from "./thread-agent-activity.js";

describe("authorized thread activity projection", () => {
  it("bounds the read to visible runs and settles missing completion without success", async () => {
    const findRuns = vi.fn(async () => [{ id: "run", status: "completed" }]);
    const findEvents = vi.fn(async () => [
      {
        id: "e",
        seq: 1,
        runId: "run",
        botId: "bot",
        type: "agent.tool.called",
        payload: { name: "read_file", executionId: "call" },
      },
    ]);
    const tx = {
      run: { findMany: findRuns },
      event: { findMany: findEvents },
    } as unknown as Prisma.TransactionClient;
    const rows = await loadThreadAgentActivity(tx, "thread");
    expect(findRuns).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ threadId: "thread" }), take: 8 }),
    );
    expect(findEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread", runId: { in: ["run"] } }),
        take: 400,
      }),
    );
    expect(rows[0]).toMatchObject({ status: "stopped", label: "Read file" });
  });
  it("does not query unscoped events when no visible run exists", async () => {
    const findMany = vi.fn();
    const tx = {
      run: { findMany: async () => [] },
      event: { findMany },
    } as unknown as Prisma.TransactionClient;
    expect(await loadThreadAgentActivity(tx, "empty")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
