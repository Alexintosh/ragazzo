// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot } from "@rakazo/contracts";
import { SetRuntimeModelInput } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  native: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  catalog: vi.fn(),
  credentials: vi.fn(),
  me: vi.fn(),
}));
vi.mock("../../lib/rpc", () => {
  const client = (spaceId: string | null) => ({
    bots: {
      runtimeModels: (input: unknown) => calls.native(input, spaceId),
      setRuntimeModel: (input: unknown) => calls.save(input, spaceId),
      update: (input: unknown) => calls.update(input, spaceId),
    },
    models: { list: calls.catalog, credentials: calls.credentials },
    me: calls.me,
  });
  return {
    rpc: client(null),
    rpcForSpace: client,
    createSpaceRpc: client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { BotModelPicker } from "./bot-model-picker";

const bot = {
  id: "11111111-1111-4111-8111-111111111111",
  spaceId: "space-1",
  runtimeKind: "codex",
  registeredHostId: null,
  modelProvider: "codex-native",
  modelId: "codex-first",
  thinkingLevel: "high",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Bot;
const nativeModels = {
  runtimeKind: "codex",
  available: true,
  defaultModelId: "codex-first",
  models: [
    {
      id: "codex-first",
      name: "Codex First",
      thinkingLevels: ["low", "medium", "high"],
      defaultThinkingLevel: "medium",
      isDefault: true,
    },
    {
      id: "codex-second",
      name: "Codex Second",
      thinkingLevels: ["low", "medium"],
      defaultThinkingLevel: "low",
      isDefault: false,
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const onSaved = vi.fn();

beforeEach(() => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => undefined;
  calls.native.mockResolvedValue(nativeModels);
  calls.save.mockImplementation(async (input) => ({
    ...bot,
    ...SetRuntimeModelInput.parse(input),
    updatedAt: "2026-01-02T00:00:00.000Z",
  }));
  calls.catalog.mockResolvedValue([]);
  calls.credentials.mockResolvedValue([]);
  calls.me.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(value = bot) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotModelPicker bot={value} onSaved={onSaved} />
      </QueryClientProvider>,
    ),
  );
  await flush();
}
async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error("Missing control");
  await act(async () => element.click());
  await flush();
}
async function open() {
  await click(container.querySelector('[data-testid="bot-model-trigger"]'));
}
function option(name: string) {
  return document.querySelector(`[role="option"][aria-label="${name}"]`);
}
async function effort(value: string) {
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Reasoning effort"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

it("shows native choices, selected check and only the selected model's supported efforts", async () => {
  await render();
  expect(container.textContent).toContain("Codex First");
  expect(calls.catalog).not.toHaveBeenCalled();
  await open();
  expect(option("Codex First")?.getAttribute("data-checked")).toBe("true");
  expect(
    [...document.querySelectorAll("select option")].map((item) => item.getAttribute("value")),
  ).toEqual(["", "low", "medium", "high"]);
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      search,
      "Second",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(option("Codex First")).toBeNull();
  expect(option("Codex Second")).not.toBeNull();
});

it("saves immediately, drops unsupported effort, and waits for acceptance before changing the trigger", async () => {
  let finish!: (value: Bot) => void;
  calls.save.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await open();
  await click(option("Codex Second"));
  expect(calls.save).toHaveBeenCalledWith(
    { botId: bot.id, modelId: "codex-second", thinkingLevel: null },
    "space-1",
  );
  expect(container.textContent).toContain("Codex First");
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelector("select")?.disabled).toBe(true);
  await act(async () =>
    finish({
      ...bot,
      modelId: "codex-second",
      thinkingLevel: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
  );
  await flush();
  expect(container.textContent).toContain("Codex Second");
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(
    [...document.querySelectorAll("select option")].map((item) => item.getAttribute("value")),
  ).toEqual(["", "low", "medium"]);
});

it("pins the effective native model when changing its default effort", async () => {
  await render({ ...bot, modelProvider: null, modelId: null, thinkingLevel: null });
  await open();
  await effort("low");
  expect(calls.save).toHaveBeenCalledWith(
    { botId: bot.id, modelId: "codex-first", thinkingLevel: "low" },
    "space-1",
  );
});

it("shows project-configured native defaults and pins that model when changing effort", async () => {
  calls.native.mockResolvedValue({
    ...nativeModels,
    defaultModelId: "codex-second",
    defaultThinkingLevel: "high",
  });
  await render({ ...bot, modelId: null, thinkingLevel: null });
  expect(container.textContent).toContain("Codex Second");
  expect(container.textContent).toContain("High");
  await open();
  expect(document.querySelector('select option[value=""]')?.textContent).toBe("Default (High)");
  await effort("low");
  expect(calls.save).toHaveBeenCalledWith(
    { botId: bot.id, modelId: "codex-second", thinkingLevel: "low" },
    "space-1",
  );
});

it("uses the explicit model's own default effort rather than project configuration", async () => {
  calls.native.mockResolvedValue({
    ...nativeModels,
    defaultModelId: "codex-first",
    defaultThinkingLevel: "high",
  });
  await render({ ...bot, modelId: "codex-second", thinkingLevel: null });
  expect(container.textContent).toContain("Codex Second");
  expect(container.textContent).toContain("Low");
  await open();
  expect(document.querySelector('select option[value=""]')?.textContent).toBe("Default (Low)");
});

it("shows Default when inherited effort cannot be resolved", async () => {
  await render({ ...bot, modelId: null, thinkingLevel: null });
  expect(container.textContent).toContain("Codex First");
  expect(container.textContent).toContain("Default");
  expect(container.textContent).not.toContain("Medium");
  await open();
  expect(document.querySelector('select option[value=""]')?.textContent).toBe("Default");
});

it("shows configured defaults even when the model is absent from the selectable catalog", async () => {
  calls.native.mockResolvedValue({
    ...nativeModels,
    defaultModelId: "host-custom-model",
    defaultThinkingLevel: "high",
  });
  await render({ ...bot, modelId: null, thinkingLevel: null });
  expect(container.textContent).toContain("host-custom-model");
  expect(container.textContent).toContain("High");
  await open();
  expect(option("Runtime default")).not.toBeNull();
  expect(option("host-custom-model")).toBeNull();
  expect(document.querySelector('select[aria-label="Reasoning effort"]')).toBeNull();
});

it("refreshes native configuration after project or runtime generation changes", async () => {
  await render({ ...bot, projectPath: "/workspace/first", runtimeGeneration: 0 });
  calls.native.mockClear();
  await render({ ...bot, projectPath: "/workspace/second", runtimeGeneration: 0 });
  expect(calls.native).toHaveBeenCalledTimes(1);
  calls.native.mockClear();
  await render({ ...bot, projectPath: "/workspace/second", runtimeGeneration: 1 });
  expect(calls.native).toHaveBeenCalledTimes(1);
});

it("returns a native bot to its runtime default and clears its effort override", async () => {
  await render();
  await open();
  await click(option("Runtime default"));
  expect(calls.save).toHaveBeenCalledWith(
    { botId: bot.id, modelId: null, thinkingLevel: null },
    "space-1",
  );
});

it("keeps the accepted value after a failed save and allows retry", async () => {
  calls.save.mockRejectedValueOnce(new Error("Host unavailable"));
  await render();
  await open();
  await click(option("Codex Second"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Host unavailable");
  expect(container.textContent).toContain("Codex First");
  await click(option("Codex Second"));
  expect(container.textContent).toContain("Codex Second");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("does not show or edit Pi catalogs when a native runtime cannot list models", async () => {
  calls.native.mockResolvedValue({
    runtimeKind: "claude",
    available: false,
    defaultModelId: null,
    models: [],
  });
  await render({ ...bot, runtimeKind: "claude", modelId: null });
  await open();
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "Model selection unavailable",
  );
  expect(document.querySelector('[role="option"]')).toBeNull();
  expect(calls.catalog).not.toHaveBeenCalled();
});

it("ignores a completed save after switching bot and Space", async () => {
  let finish!: (value: Bot) => void;
  calls.save.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await open();
  await click(option("Codex Second"));
  await render({ ...bot, id: "bot-2", spaceId: "space-2", modelId: "codex-second" });
  await act(async () => finish({ ...bot, modelId: "codex-second" }));
  await flush();
  expect(onSaved).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Codex Second");
  expect(calls.native).toHaveBeenCalledWith({ botId: "bot-2" }, "space-2");
});

it("uses the existing Pi update with only model fields and preserves supported effort", async () => {
  const entry = {
    provider: "fixture",
    id: "first",
    label: "Fixture First",
    thinkingLevels: ["low", "high"],
  };
  calls.catalog.mockResolvedValue([entry, { ...entry, id: "second", label: "Fixture Second" }]);
  calls.credentials.mockResolvedValue([{ provider: "fixture", modelId: "first" }]);
  calls.me.mockResolvedValue({ defaultProvider: "fixture", defaultModel: "first" });
  calls.update.mockImplementation(async (input) => ({
    ...bot,
    ...input,
    runtimeKind: "pi",
    updatedAt: "2026-01-02T00:00:00.000Z",
  }));
  await render({ ...bot, runtimeKind: "pi", modelProvider: "fixture", modelId: "first" });
  await open();
  await click(document.querySelector('[data-value="fixture::second"]'));
  expect(calls.update).toHaveBeenCalledWith(
    { botId: bot.id, modelProvider: "fixture", modelId: "second", thinkingLevel: "high" },
    "space-1",
  );
  expect(calls.native).not.toHaveBeenCalled();
  expect(calls.save).not.toHaveBeenCalled();
});
