import type { CreateBotInput } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  add: vi.fn(),
  schedule: vi.fn(),
  session: { generation: 1 },
}));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./search-inbox", () => ({
  addToSearchInbox: state.add,
  searchInboxSession: () => state.session,
}));
vi.mock("./focus-prompt", () => ({
  allowFocusPrompt: vi.fn(),
  scheduleFocusPrompt: state.schedule,
}));

import { createInboxBot } from "./create-inbox-bot";

beforeEach(() => {
  vi.clearAllMocks();
  state.rpc.mockImplementation(async (method: string) =>
    method === "bots/create" ? { id: "bot-new", name: "Builder" } : [],
  );
});
it.each(["codex", "claude", "acp"] as const)(
  "creates %s and registered placement atomically before onboarding",
  async (runtimeKind) => {
    const open = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const input = {
      name: " Builder ",
      title: "Engineer",
      description: " Build a prototype ",
      runtimeKind,
      registeredHostId: "registered-host",
      executionTarget: "host",
      runtimePermission: runtimeKind === "codex" ? "workspace" : "full",
      projectPath: "/project",
      computerMode: "dedicated",
      spawnKey: "create-once",
    } satisfies Partial<CreateBotInput>;
    await createInboxBot({ input, openChat: open, refreshBots: refresh });
    expect(state.rpc.mock.calls.map(([method]) => method)).toEqual([
      "bots/list",
      "bots/create",
      "onboarding/start",
    ]);
    expect(state.rpc).toHaveBeenCalledWith(
      "bots/create",
      expect.objectContaining({
        name: "Builder",
        title: "Engineer",
        description: "Build a prototype",
        runtimeKind,
        registeredHostId: "registered-host",
        executionTarget: "host",
        runtimePermission: runtimeKind === "codex" ? "workspace" : "full",
        projectPath: "/project",
        computerMode: "dedicated",
        spawnKey: "create-once",
      }),
    );
    expect(open).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-new", name: "Builder" },
    });
    expect(refresh).toHaveBeenCalledOnce();
  },
);
it("does not publish or onboard a bot when creation is refused", async () => {
  state.rpc.mockImplementation(async (method: string) => {
    if (method === "bots/create") throw new Error("Host is disabled");
    return [];
  });
  const open = vi.fn();
  await expect(
    createInboxBot({
      input: { runtimeKind: "codex", executionTarget: "host" },
      refreshBots: async () => undefined,
      openChat: open,
    }),
  ).rejects.toThrow("Host is disabled");
  expect(open).not.toHaveBeenCalled();
  expect(state.add).not.toHaveBeenCalled();
  expect(state.rpc.mock.calls.some(([method]) => method === "onboarding/start")).toBe(false);
});
