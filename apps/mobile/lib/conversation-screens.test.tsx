// @vitest-environment jsdom
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConversationWork from "../app/conversation-work";
import TaskConversation from "../app/task-conversation";
import Workflows from "../app/workflows";
import type * as MobileApi from "./api";
import { queryClient } from "./query";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  rpc: vi.fn(),
  push: vi.fn(),
  space: "space-a",
  enqueueFailures: 0,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./api", async (original) => {
  const actual = await original<typeof MobileApi>();
  return {
    ...actual,
    rpc: state.rpc,
    currentApiBase: () => "https://api.example.test",
    selectedSpaceId: () => state.space,
    spaceSelectionSeq: () => 0,
    captureApiRequestContext: async () => ({
      apiBase: "https://api.example.test",
      sessionGeneration: 1,
      headers: { "x-rakazo-space-id": state.space },
    }),
    selectSpace: async (id: string) => {
      state.space = id;
      return true;
    },
    subscribeThread: async (
      _target: unknown,
      _cursor: number,
      _event: unknown,
      signal: AbortSignal,
    ) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  };
});
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => state.params,
  useIsFocused: () => true,
  useRouter: () => ({ push: state.push, replace: state.push }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    ScrollView: view,
    View: view,
    Text: view,
    ActivityIndicator: () => createElement("progress"),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel: string;
      editable?: boolean;
    }) =>
      createElement("input", {
        value,
        disabled: editable === false,
        "aria-label": accessibilityLabel,
        onInput: (event: React.FormEvent<HTMLInputElement>) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("./i18n", () => ({
  t: (key: string) => key,
  dateLocaleForUi: () => "en",
  useI18n: () => ({ t: (key: string) => key, locale: "en" }),
}));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./live-notifications", () => ({
  dismissThreadNotifications: vi.fn(async () => undefined),
  setOpenNotificationThread: vi.fn(async () => undefined),
}));
vi.mock("./thread-attachments", () => ({
  useThreadAttachments: () => ({
    activePendingAttachments: [],
    attachActions: [],
    setPendingAttachments: vi.fn(),
    attachFrom: vi.fn(),
  }),
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/thread/message-bubble", () => ({
  MessageBubble: ({ message }: { message: { id: string } }) =>
    createElement("div", { "data-message": message.id }, message.id),
}));
vi.mock("../components/image-artifact-viewer", () => ({ ImageArtifactViewer: () => null }));
vi.mock("../components/markdown-artifact-preview", () => ({ MarkdownArtifactPreview: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled: disabled || busy },
      label,
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children?: ReactNode; label?: string }) =>
    createElement("section", null, label, children),
  SettingsRow: ({
    title,
    detail,
    onPress,
    disabled,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, title, detail),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.currentTarget.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));

let root: Root;
let container: HTMLDivElement;
const workflow = {
  id: "workflow-a",
  name: "Build",
  revision: 7,
  graph: {
    nodes: [{ id: "draft", label: "Draft", botId: "bot-a", prompt: "Write draft", x: 0, y: 0 }],
    edges: [],
  },
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const workflowRun = {
  id: "workflow-run-a",
  workflowId: workflow.id,
  name: workflow.name,
  revision: 12,
  graph: workflow.graph,
  nodes: [
    { nodeId: "draft", status: "waiting_approval", taskId: "task-a", runId: "run-a", error: null },
  ],
  status: "running",
  createdAt: workflow.createdAt,
  updatedAt: workflow.updatedAt,
};
const task = {
  id: "task-a",
  threadId: "task-thread",
  botId: "bot-a",
  botName: "Writer",
  prompt: "Write draft",
  status: "running",
  runId: "run-a",
  originThreadId: null,
  recoveryOfRunId: null,
  createdAt: workflow.createdAt,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler((callback) => callback());
  queryClient.clear();
  state.params = {};
  state.push.mockReset();
  state.space = "space-a";
  state.enqueueFailures = 0;
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "threads/queue")
        return { revision: 3, entries: [], canSteer: false, waitingReason: "running" };
      if (proc === "tasks/list") return { tasks: [task], nextCursor: null };
      if (proc === "tasks/stopped") return { runs: [] };
      if (proc === "tasks/get") return task;
      if (proc === "me") return { userId: "owner-a" };
      if (proc === "bots/list") return [];
      if (proc === "threads/get")
        return {
          threadId: "task-thread",
          botId: "bot-a",
          cursor: 4,
          messages: [],
          olderCursor: null,
          run: { id: "run-a", status: "running" },
        };
      if (proc === "threads/enqueue") {
        if (state.enqueueFailures-- > 0) throw new Error("Try again");
        return { revision: 4, entries: [], canSteer: false, waitingReason: "running" };
      }
      if (proc === "workflows/list") return { workflows: [workflow] };
      if (proc === "workflows/get") return workflow;
      if (proc === "workflows/runs") return { runs: [workflowRun] };
      if (proc === "workflows/run") return workflowRun;
      if (proc === "workflows/cancel") return { ...workflowRun, revision: 13, status: "cancelled" };
      if (proc === "workflows/start") return workflowRun;
      if (proc === "groups/get") return { members: [{ botId: "bot-a", name: "Writer" }] };
      return input ? { ok: true } : [];
    });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.unstubAllGlobals();
});
async function render(screen: ReactNode) {
  await act(async () => root.render(screen));
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function change(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps a failed queue draft and retries with the same nonce", async () => {
  state.params = { botId: "bot-a" };
  state.enqueueFailures = 1;
  await render(createElement(ConversationWork));
  await change("Task prompt", "Later");
  await click("Queue message");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Task prompt"]')?.value).toBe(
    "Later",
  );
  await click("Queue message");
  const calls = state.rpc.mock.calls.filter(([proc]) => proc === "threads/enqueue");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
  expect(calls[1]?.[1]).toMatchObject({
    botId: "bot-a",
    text: "Later",
    clientNonce: expect.any(String),
  });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Task prompt"]')?.value).toBe(
    "",
  );
});
it("does not request a group queue until a recipient is chosen", async () => {
  state.params = { groupId: "group-a" };
  await render(createElement(ConversationWork));
  expect(state.rpc.mock.calls.some(([proc]) => proc === "threads/queue")).toBe(false);
  expect(state.rpc).toHaveBeenCalledWith(
    "tasks/stopped",
    { groupId: "group-a" },
    expect.any(Object),
  );
});
it("sends task messages to the task conversation rather than the executing bot", async () => {
  state.params = { taskId: "task-a" };
  await render(createElement(TaskConversation));
  await change("Message", "Continue");
  await click("Send");
  const sent = state.rpc.mock.calls.find(([proc]) => proc === "threads/send");
  expect(sent?.[1]).toMatchObject({
    taskId: "task-a",
    text: "Continue",
    artifactIds: [],
    clientNonce: expect.any(String),
  });
  expect(sent?.[1]).not.toHaveProperty("botId");
});
it("opens workflow approval tasks and cancels with the current run revision", async () => {
  await render(createElement(Workflows));
  const node = [...container.querySelectorAll("button")].find((value) =>
    value.textContent?.startsWith("DraftNeeds input"),
  );
  expect(node).toBeDefined();
  await act(async () => node!.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/task-conversation",
    params: { taskId: "task-a" },
  });
  await click("Cancel workflow");
  expect(state.rpc).toHaveBeenCalledWith(
    "workflows/cancel",
    { runId: "workflow-run-a", revision: 12 },
    expect.any(Object),
  );
});
