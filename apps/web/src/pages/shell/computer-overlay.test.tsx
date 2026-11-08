// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: () => null }));
vi.mock("../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: () => null,
  TeachStopButton: () => null,
}));

import { ComputerOverlay } from "./computer-overlay";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada", color: "ink", status: "idle" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(
  state: ComputerStatus["state"],
  onStart = vi.fn(),
  onClose = vi.fn(),
  overrides: Partial<ComponentProps<typeof ComputerOverlay>> = {},
) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={computer(state)}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
        onRefreshComputer={async () => undefined}
        onClose={onClose}
        {...overrides}
      />,
    );
  });
  return onStart;
}

function startButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers Start for a stopped computer instead of a bare label", async () => {
  const onStart = await render("stopped");
  expect(container.textContent).toContain("Computer is stopped");
  await act(async () => startButton()?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("offers Start for an asleep computer", async () => {
  await render("suspended");
  expect(container.textContent).toContain("Computer is asleep");
  expect(startButton()).toBeDefined();
});

it("returns to the conversation using the existing close action", async () => {
  const onClose = vi.fn();
  await render("running", vi.fn(), onClose);
  const conversation = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Conversation",
  );
  await act(async () => conversation?.click());
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows the host browser in the same sandboxed computer view and gates input on takeover", async () => {
  const status = { ...computer("running"), kind: "desktop" as const, screenAvailable: true };
  const url = "/novnc/session/view/1.fake/browser-screen/session/embed.html";
  await render("running", undefined, undefined, { computer: status, embeddedScreenUrl: url });
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe(url);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-pointer-lock");
  expect(frame?.style.pointerEvents).toBe("none");
  await render("running", undefined, undefined, {
    computer: status,
    embeddedScreenUrl: url,
    hasControl: true,
  });
  expect(container.querySelector("iframe")?.style.pointerEvents).toBe("auto");
});
