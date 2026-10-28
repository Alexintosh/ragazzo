import { describe, expect, it, vi } from "vitest";
import type { CodexClient } from "./codex-app-server.js";
import { codexRuntimeModels } from "./codex-runtime-models.js";

describe("installed Codex model catalog", () => {
  function client(pages: unknown[]) {
    return {
      request: vi.fn(async () => pages.shift()),
      reply: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    } satisfies CodexClient;
  }
  const model = {
    model: "test-model",
    displayName: "Test model",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
    defaultReasoningEffort: "low",
  };
  it("uses paginated installed choices and keeps native effort levels", async () => {
    const api = client([
      { data: [model], nextCursor: "next" },
      { data: [{ ...model, model: "hidden", hidden: true }], nextCursor: null },
    ]);
    const result = await codexRuntimeModels(api);
    expect(result).toEqual({
      runtimeKind: "codex",
      available: true,
      defaultModelId: "test-model",
      models: [
        {
          id: "test-model",
          name: "Test model",
          isDefault: true,
          thinkingLevels: ["low", "ultra"],
          defaultThinkingLevel: "low",
        },
      ],
    });
    expect(api.request.mock.calls).toEqual([
      ["model/list", { limit: 100 }],
      ["model/list", { limit: 100, cursor: "next" }],
    ]);
  });
  it("maps protocol none to off and never invents unsupported efforts", async () => {
    const result = await codexRuntimeModels(
      client([
        {
          data: [
            {
              ...model,
              supportedReasoningEfforts: [
                { reasoningEffort: "none" },
                { reasoningEffort: "future" },
              ],
              defaultReasoningEffort: "future",
            },
          ],
          nextCursor: null,
        },
      ]),
    );
    expect(result.models[0]).toMatchObject({ thinkingLevels: ["off"], defaultThinkingLevel: null });
  });
  it("rejects malformed catalogs and pagination loops", async () => {
    await expect(codexRuntimeModels(client([{ data: [{}] }]))).rejects.toThrow("invalid");
    await expect(
      codexRuntimeModels(
        client([
          { data: [], nextCursor: "same" },
          { data: [], nextCursor: "same" },
        ]),
      ),
    ).rejects.toThrow("pagination");
  });
});
