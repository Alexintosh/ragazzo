import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import type { RunContext } from "./run-context.js";
import { nextMutatingEffectOccurrence, restoreTurnCheckpointEffects } from "./run-context.js";

function context() {
  return {
    runId: "run",
    state: { effects: { occurrences: [], counts: new Map(), restoredPending: undefined } },
  } as unknown as RunContext;
}
describe("native application tool effect checkpoint", () => {
  it("restores completed reservations and reuses only the pending call's occurrence", () => {
    const ctx = context();
    const args = { text: "note" };
    const fingerprint = toolEffectIdempotencyKey("run", "notes.write", args);
    const pendingId = JSON.stringify(["native-tool", "run", "pending"]);
    const checkpoint = JSON.stringify({
      runtime: "codex",
      pendingToolCall: { executionId: pendingId },
      effectOccurrences: [
        { executionId: "completed", fingerprint, occurrence: 0 },
        { executionId: pendingId, fingerprint, occurrence: 1 },
      ],
    });
    expect(
      restoreTurnCheckpointEffects(ctx, checkpoint, { provider: "codex-native", id: "default" }),
    ).toBe(checkpoint);
    expect(nextMutatingEffectOccurrence(ctx, "notes.write", args, pendingId)).toBe(1);
    expect(nextMutatingEffectOccurrence(ctx, "notes.write", args, "next-call")).toBe(2);
    expect(nextMutatingEffectOccurrence(ctx, "notes.write", args, pendingId)).toBe(3);
  });
  it("retains completed native transcripts without restoring old effect reservations", () => {
    const ctx = context();
    const checkpoint = JSON.stringify({
      runtime: "codex",
      completed: true,
      effectOccurrences: [{ executionId: "completed", fingerprint: "old", occurrence: 9 }],
    });
    expect(
      restoreTurnCheckpointEffects(ctx, checkpoint, { provider: "codex-native", id: "default" }),
    ).toBe(checkpoint);
    expect(ctx.state.effects.occurrences).toEqual([]);
  });
  it("refuses malformed effect reservations", () => {
    const ctx = context();
    expect(
      restoreTurnCheckpointEffects(
        ctx,
        JSON.stringify({
          runtime: "codex",
          effectOccurrences: [{ executionId: "pending", fingerprint: "effect", occurrence: -1 }],
        }),
        { provider: "codex-native", id: "default" },
      ),
    ).toBeUndefined();
  });
});
