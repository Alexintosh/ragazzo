import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createRunReasoning } from "./run-reasoning.js";

function fixture(trigger = "user") {
  const append = vi.fn(async (_input: Record<string, unknown>) => ({}));
  const ctx = {
    secrets: ["fixture-secret-123"],
    run: { spaceId: "space", threadId: "thread", trigger },
    bot: { id: "bot" },
    runId: "run",
    workerId: "worker",
    fence: 2,
    deps: { events: { append } },
  } as unknown as RunContext;
  return { append, ctx, reasoning: createRunReasoning(ctx) };
}
describe("public reasoning summaries", () => {
  it("redacts split secrets, throttles cumulative text and fences writes", async () => {
    const { append, reasoning } = fixture();
    await reasoning.push("Checking fixture-se");
    await reasoning.push("cret-123 then files");
    await reasoning.finish();
    const writes = append.mock.calls.map((call) => call[0]);
    expect(JSON.stringify(writes)).not.toContain("fixture-secret");
    expect(writes.at(-1)).toMatchObject({
      type: "agent.reasoning",
      lease: { owner: "worker", fence: 2 },
      payload: { text: "Checking [redacted] then files", done: true },
    });
    expect(append).toHaveBeenCalledTimes(2);
    await reasoning.finish();
    expect(append).toHaveBeenCalledTimes(2);
  });
  it("caps public summary size and separates subsequent phases", async () => {
    const { append, reasoning } = fixture();
    await reasoning.push("a".repeat(20_000));
    await reasoning.finish();
    const first = append.mock.calls.at(-1)?.[0] as any;
    expect(first.payload.text).toHaveLength(16_384);
    await reasoning.push("Next phase");
    await reasoning.finish();
    const last = append.mock.calls.at(-1)?.[0] as any;
    expect(last.payload.id).not.toBe(first.payload.id);
  });
  it("includes secrets learned between summary phases", async () => {
    const { append, ctx, reasoning } = fixture();
    await reasoning.push("First phase");
    await reasoning.finish();
    ctx.secrets.push("new-fixture-secret");
    await reasoning.push("Use new-fixture-secret next");
    await reasoning.finish();
    expect(JSON.stringify(append.mock.calls)).not.toContain("new-fixture-secret");
  });
  it("does not publish peer or background reasoning", async () => {
    const { append, reasoning } = fixture("bot_message");
    await reasoning.push("Private peer summary");
    await reasoning.finish();
    expect(append).not.toHaveBeenCalled();
  });
});
