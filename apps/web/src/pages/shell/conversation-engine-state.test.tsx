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
  settings: { revision: 0, values: {} },
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
const saveSettings = vi.fn(
  async (
    _state: ConversationEngineState,
    values: ConversationEngineState["settings"]["values"],
  ) => ({ revision: 1, values }),
);
const action = vi.fn(async () => ({
  status: "completed" as "completed" | "uncertain",
  message: null,
}));
const save = vi.fn(async (_state: ConversationEngineState, _edit: unknown) => initial);
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  load.mockReset().mockResolvedValue(structuredClone(initial));
  save.mockClear();
  saveSettings.mockClear();
  action.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(busy = false, controls = false) {
  await act(async () =>
    root.render(
      <ConversationEngineStatePanel
        onLoad={load}
        onSave={save}
        busy={busy}
        onSaveSettings={controls ? saveSettings : undefined}
        onAction={controls ? action : undefined}
      />,
    ),
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
  it("saves request settings before initialization without mutating conversation state", async () => {
    load.mockResolvedValueOnce({
      ...structuredClone(initial),
      status: "uninitialized",
      inspection: null,
    });
    await render(false, true);
    for (const label of [
      "Needs",
      "Relationship evolution",
      "User insights",
      "Events and daily life",
      "Inventory and outfit",
      "Initiative and greetings",
      "Behavior traits",
      "Model generation",
    ]) {
      expect(
        [...container.querySelectorAll("summary")].some((summary) => summary.textContent === label),
      ).toBe(true);
    }
    await change("Model tier", "fast");
    await change("Outfit", "Travel coat");
    await click("Save settings");
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ historyGeneration: 2, settings: { revision: 0, values: {} } }),
      { tier: "fast", outfit: "Travel coat" },
    );
    expect(save).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
  it("preserves conflicting configuration drafts until discarded", async () => {
    await render(false, true);
    await change("Model tier", "fast");
    load.mockResolvedValueOnce({
      ...structuredClone(initial),
      settings: { revision: 3, values: { tier: "quality" } },
    });
    await click("Refresh");
    expect(field("Model tier").value).toBe("fast");
    await click("Save settings");
    expect(saveSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Settings changed. Discard edits");
    await click("Discard settings");
    expect(field("Model tier").value).toBe("quality");
  });
  it("reads native needs and prevents repeating uncertain actions", async () => {
    const next = structuredClone(initial);
    next.inspection!.needs = {
      hunger: "high",
      social: "mid",
      stamina: "low",
      emotional: "mid",
      outing: "low",
      indulgence: "low",
    };
    load.mockResolvedValueOnce(next);
    action.mockResolvedValueOnce({ status: "uncertain", message: null });
    await render(false, true);
    expect(container.textContent).toContain("Direct overrides are unavailable.");
    await click("Greet now");
    expect(action).toHaveBeenCalledWith(expect.anything(), {
      kind: "open",
      occasion: "just_opened",
    });
    expect(container.textContent).toContain("Action outcome is uncertain");
    await click("Draw event");
    expect(action).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("refreshes inventory after an explicit native item action", async () => {
    await render(false, true);
    await change("Item name", "Compass");
    await click("Add item");
    expect(action).toHaveBeenCalledWith(expect.anything(), {
      kind: "add_item",
      itemKind: "item",
      name: "Compass",
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("renders deployment sampling as read-only and offers only native model profiles", async () => {
    const next = structuredClone(initial);
    next.inspection!.debug!.generation = {
      tasks: [
        { name: "reply", models: ["local-model"], fallback: [], temperature: 0.7, maxTokens: 2048 },
      ],
      profiles: ["fast", "quality"],
    };
    load.mockResolvedValueOnce(next);
    await render(false, true);
    expect(field("Model tier").tagName).toBe("SELECT");
    expect(container.querySelector("table")?.textContent).toContain("local-model");
    expect(container.querySelector("table")?.textContent).toContain("0.7");
    expect(container.querySelector("table input")).toBeNull();
    expect(
      [...field("Model tier").querySelectorAll("option")].map((option) => option.value),
    ).toEqual(["", "fast", "quality"]);
  });
  it("allows a new bot to greet while event and inventory actions require initialization", async () => {
    load.mockResolvedValueOnce({
      ...structuredClone(initial),
      status: "uninitialized",
      inspection: null,
    });
    await render(false, true);
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
    expect(button("Greet now").disabled).toBe(false);
    expect(button("Draw event").disabled).toBe(true);
    expect(field("Item name").closest("fieldset")?.disabled).toBe(true);
    await click("Greet now");
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ status: "uninitialized" }), {
      kind: "open",
      occasion: "just_opened",
    });
    await render(true, true);
    expect(button("Greet now").disabled).toBe(true);
  });
});
