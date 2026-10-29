// @vitest-environment jsdom
import type { ConversationEngineState } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (result, part, index) => result + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
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
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import { ConversationEngineStatePanel } from "./conversation-engine-state";

const character = { id: "00000000-0000-4000-8000-000000000001", name: "Aster" };
const initial: ConversationEngineState = {
  engineId: "eros",
  status: "ready",
  character,
  historyGeneration: 2,
  inspection: {
    profile: {
      location: "Glass Harbor",
      occupation: null,
      currentSituation: null,
      desires: null,
      vulnerabilities: null,
      habits: null,
      personalValues: null,
      likes: ["Maps"],
      dislikes: [],
      relationships: [],
      updatedAt: null,
    },
    affinity: {
      trust: 0.2,
      intrigue: 0.3,
      intimacy: 0.4,
      tension: 0.1,
      warmth: 0.5,
      patience: 0.6,
      bond: 0.3,
      chemistry: 0.2,
      bondTier: 2,
      chemistryTier: 1,
      bondLabel: "Familiar",
      chemistryLabel: "Neutral",
      ghostStreak: 0,
      totalGhosts: 0,
      updatedAt: "2026-10-01T12:00:00Z",
    },
    latestEvent: null,
    emotionalNeed: "mid",
    asOf: "2026-10-01T12:00:00Z",
    changesAt: null,
    observedAt: "2026-10-01T12:00:00Z",
    debug: {
      feeling: "Curious about the unfamiliar chart.",
      feelingUpdatedAt: "2026-10-01T11:59:00Z",
      persona: {
        name: "Aster",
        systemPrompt: "A careful cartographer. Stay in character.",
        tipPersonality: "Careful and curious.",
        timezone: "UTC",
      },
      axes: { trust: 0.2, intrigue: 0.3, intimacy: 0.4, tension: 0.1 },
      warmthGrade: 2,
      patienceGrade: 2,
      revision: "revision-one",
      editable: true,
      editBlockedReason: null,
      time: {
        timezone: "UTC",
        currentTime: "2026-10-01T12:00:00Z",
        localTime: "2026-10-01 12:00:00",
        affinityElapsedHours: 0,
        feelingElapsedHours: 1 / 60,
      },
    },
  },
};
let container: HTMLDivElement;
let root: Root;
const load = vi.fn<() => Promise<ConversationEngineState>>();
const save = vi.fn(async (_state: ConversationEngineState, _edit: unknown) => initial);
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  load.mockReset().mockResolvedValue(structuredClone(initial));
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(busy = false) {
  await act(async () =>
    root.render(<ConversationEngineStatePanel onLoad={load} onSave={save} busy={busy} />),
  );
}
function field(label: string) {
  const el = [...container.querySelectorAll("label")].find((el) =>
    el.textContent?.startsWith(label),
  )!;
  return container.querySelector<HTMLInputElement>(`[id="${el.htmlFor}"]`)!;
}
async function change(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((el) => el.textContent?.startsWith(label))!
      .click();
  });
}

describe("ConversationEngineStatePanel", () => {
  it("shows character instructions and keeps debug progressively disclosed", async () => {
    await render();
    expect(load).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("A careful cartographer");
    expect(
      [...container.querySelectorAll("details")].find(
        (el) => el.querySelector("summary")?.textContent === "Eros debug",
      )?.open,
    ).toBe(false);
    expect(container.textContent).toContain("Curious about the unfamiliar chart.");
    expect(container.textContent).toContain("Emotional need");
    expect(container.textContent).toContain("Medium");
    expect(save).not.toHaveBeenCalled();
  });
  it("validates explicit edits, preserves failed drafts and refreshes the revision", async () => {
    await render();
    await change("Trust", "2");
    await click("Save changes");
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter numbers from 0 to 1.");
    await click("Discard");
    expect(field("Trust").value).toBe("0.2");
    await change("Trust", "0.8");
    save.mockRejectedValueOnce(new Error("State changed. Refresh and try again."));
    await click("Save changes");
    expect(field("Trust").value).toBe("0.8");
    expect(container.textContent).toContain("State changed");
    await click("Save changes");
    expect(save.mock.lastCall?.[1]).toEqual({
      expectedRevision: "revision-one",
      axes: { trust: 0.8, intrigue: 0.3, intimacy: 0.4, tension: 0.1 },
      warmthGrade: 2,
      patienceGrade: 2,
    });
    await click("Refresh");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("shows blocked native inputs and automatically unlocks after settling", async () => {
    vi.useFakeTimers();
    try {
      const settling = structuredClone(initial);
      settling.inspection!.debug!.editable = false;
      settling.inspection!.debug!.editBlockedReason = "settling";
      load.mockResolvedValueOnce(settling);
      await render();
      expect(field("Trust").closest("fieldset")?.disabled).toBe(true);
      expect(container.textContent).toContain("Settling…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(field("Trust").closest("fieldset")?.disabled).toBe(false);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves drafts through a refresh and validates per-conversation elapsed time", async () => {
    await render();
    await change("Trust", "0.8");
    await change("Simulate elapsed hours", "721");
    await click("Save changes");
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter elapsed hours from 0 to 720.");
    await change("Simulate elapsed hours", "48");
    await click("Refresh");
    expect(field("Trust").value).toBe("0.8");
    expect(field("Simulate elapsed hours").value).toBe("48");
    await click("Save changes");
    expect(save.mock.lastCall?.[1]).toMatchObject({
      elapsedHours: 48,
      axes: { trust: 0.8 },
    });
    expect(field("Simulate elapsed hours").value).toBe("");
  });
  it("keeps the draft revision when refreshed state changes", async () => {
    await render();
    await change("Trust", "0.8");
    const next = structuredClone(initial);
    next.inspection!.debug!.revision = "revision-two";
    next.inspection!.debug!.axes!.intrigue = 0.9;
    load.mockResolvedValueOnce(next);
    await click("Refresh");
    await click("Save changes");
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "State changed. Discard edits to use the latest values.",
    );
    await click("Discard");
    expect(field("Intrigue").value).toBe("0.9");
    await change("Trust", "0.8");
    await click("Save changes");
    expect(save.mock.lastCall?.[1]).toMatchObject({ expectedRevision: "revision-two" });
  });
  it("refreshes after a reply ends without overwriting unsaved edits", async () => {
    await render();
    await change("Trust", "0.8");
    await render(true);
    await render(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(field("Trust").value).toBe("0.8");
  });
  it("handles absent bridge and empty state without inventing emotional values", async () => {
    const state = structuredClone(initial);
    state.inspection!.debug = null;
    state.inspection!.emotionalNeed = null;
    load.mockResolvedValueOnce(state);
    await render();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Not available");
    load.mockResolvedValueOnce({
      ...initial,
      status: "uninitialized",
      inspection: null,
    });
    await click("Refresh");
    expect(container.textContent).toContain("Start a conversation");
    expect(container.textContent).not.toContain("Curious about");
  });
  it("retries load errors and disables edits while the bot runs", async () => {
    load.mockRejectedValueOnce(new Error("Engine unavailable"));
    await render(true);
    expect(container.textContent).toContain("Engine unavailable");
    await click("Refresh");
    expect(field("Trust").closest("fieldset")?.disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
