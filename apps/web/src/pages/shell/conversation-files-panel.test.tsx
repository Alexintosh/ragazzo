// @vitest-environment jsdom
import type { ConversationFiles } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Spinner: (props: ComponentProps<"span">) => <span role="status" {...props} />,
}));
vi.mock("../../lib/artifact-open", () => ({
  decodeArtifactBase64: () => new Uint8Array([1, 2]),
  downloadArtifactBytes: vi.fn(),
}));

import { downloadArtifactBytes } from "../../lib/artifact-open";
import { ConversationFilesPanel } from "./conversation-files-panel";

const data: ConversationFiles = {
  items: [
    {
      id: "latest",
      familyId: "root",
      botId: "bot",
      groupId: null,
      runId: "run",
      name: "report.txt",
      description: null,
      mimeType: "text/plain",
      size: 12,
      version: 2,
      versionCount: 2,
      origin: "generated",
      messageId: "source",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
  storage: { files: 1, versions: 2, bytes: 22 },
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let props: ComponentProps<typeof ConversationFilesPanel>;
const listConversation = vi.fn();
const getById = vi.fn();
async function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ConversationFilesPanel {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  listConversation.mockResolvedValue(data);
  getById.mockResolvedValue({ contentBase64: "AQI=" });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    rpc: { artifacts: { listConversation, getById } } as unknown as RpcClient,
    spaceId: "space",
    target: { botId: "bot" },
    onJumpToMessage: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});
it("shows stored version bytes, opens the existing artifact and jumps to its message", async () => {
  await render();
  expect(
    container.querySelector('[data-testid="conversation-files-storage"]')?.textContent,
  ).toContain("22 B");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/app/artifacts/root");
  expect(container.textContent).toContain("Generated");
  act(() => button("Show message").click());
  expect(props.onJumpToMessage).toHaveBeenCalledWith("source");
  await act(async () => button("Download").click());
  expect(getById).toHaveBeenCalledWith({ artifactId: "latest" });
  expect(downloadArtifactBytes).toHaveBeenCalledWith(
    "report.txt",
    "text/plain",
    new Uint8Array([1, 2]),
  );
});
it("does not offer a message link when provenance is missing", async () => {
  listConversation.mockResolvedValue({ ...data, items: [{ ...data.items[0], messageId: null }] });
  await render({ target: { taskId: "task" } });
  expect(listConversation).toHaveBeenCalledWith({ taskId: "task" });
  expect(button("Show message")).toBeUndefined();
});
it("keeps a delayed previous space response out of the current panel", async () => {
  let resolveOld!: (value: ConversationFiles) => void;
  listConversation.mockImplementationOnce(
    () =>
      new Promise<ConversationFiles>((resolve) => {
        resolveOld = resolve;
      }),
  );
  await render();
  const otherList = vi.fn(async () => ({
    items: [],
    storage: { bytes: 0, files: 0, versions: 0 },
  }));
  await render({
    spaceId: "other-space",
    rpc: { artifacts: { listConversation: otherList } } as unknown as RpcClient,
  });
  await act(async () => resolveOld(data));
  expect(container.textContent).toContain("No files yet.");
  expect(container.textContent).not.toContain("report.txt");
});
it("lets a failed list request be retried without reporting an empty result", async () => {
  listConversation.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(container.textContent).toContain("Could not load files.");
  expect(container.textContent).not.toContain("No files yet.");
  await act(async () => button("Retry").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.textContent).toContain("report.txt");
});
