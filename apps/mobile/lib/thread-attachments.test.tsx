// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useThreadAttachments } from "./thread-attachments";

const mocks = vi.hoisted(() => ({
  picker: vi.fn(async () => ({ attachments: [], skipped: [] })),
  drop: vi.fn(),
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./pick-attachments", () => ({
  pickDocuments: mocks.picker,
  pickFromLibrary: mocks.picker,
  takePhoto: mocks.picker,
  readDroppedFiles: mocks.picker,
}));
vi.mock("./use-file-drop", () => ({ useFileDrop: mocks.drop }));

it("blocks direct attachment requests and native drops in text-only chats", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let attachments: ReturnType<typeof useThreadAttachments> | undefined;
  function Harness() {
    attachments = useThreadAttachments({
      botId: "rp-bot",
      readOnly: false,
      attachmentsEnabled: false,
    });
    return null;
  }
  try {
    act(() => root.render(<Harness />));
    act(() => {
      attachments!.attachFrom("file");
      attachments!.attachFrom("library");
      attachments!.attachFrom("camera");
      mocks.drop.mock.calls.at(-1)![1]({ files: [], skipped: [] });
    });
    expect(mocks.picker).not.toHaveBeenCalled();
    expect(mocks.drop.mock.calls.at(-1)![2]).toMatchObject({ enabled: false });
  } finally {
    act(() => root.unmount());
  }
});
