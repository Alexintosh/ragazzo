import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { cancelComputerRunWork } from "./computer-idle.js";
import { NATIVE_CODEX_CLEANUP_FAILED_MESSAGE } from "./host-computer-errors.js";

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "desktop",
  providerRef: "host-1",
};
const context: AdapterContext = {
  operationId: "operation-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function cancelWith(error: unknown) {
  const sandbox: Pick<SandboxProvider, "execute" | "cancelRunWork"> = {
    execute: vi.fn(),
    cancelRunWork: vi.fn().mockRejectedValue(error),
  };
  return cancelComputerRunWork(sandbox, computer, computer.id, "run-1", context);
}

describe("cancel computer run work errors", () => {
  it("propagates an uncertain native cleanup result", async () => {
    const error = new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
    await expect(cancelWith(error)).rejects.toBe(error);
  });

  it.each([
    new Error("unrelated provider failure"),
    new Error(`${NATIVE_CODEX_CLEANUP_FAILED_MESSAGE}: private detail`),
    { message: NATIVE_CODEX_CLEANUP_FAILED_MESSAGE },
  ])("keeps other cleanup failures best effort (%#)", async (error) => {
    await expect(cancelWith(error)).resolves.toBeUndefined();
  });
});
