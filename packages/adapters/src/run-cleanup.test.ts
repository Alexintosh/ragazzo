import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { cancelComputerRunWork } from "./computer-idle.js";

it("preserves cleanup transport failure when a deliberate recovery requires acknowledgement", async () => {
  const error = new Error("host offline");
  const sandbox = { cancelRunWork: vi.fn().mockRejectedValue(error) } as unknown as SandboxProvider;
  const computer: ComputerRef = { id: "host", botId: "home", kind: "desktop", providerRef: "host" };
  const context: AdapterContext = {
    operationId: "recover",
    traceId: "recover",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  await expect(
    cancelComputerRunWork(sandbox, computer, "computer", "run", context),
  ).resolves.toBeUndefined();
  await expect(
    cancelComputerRunWork(sandbox, computer, "computer", "run", {
      ...context,
      requireRunCleanup: true,
    }),
  ).rejects.toBe(error);
});
