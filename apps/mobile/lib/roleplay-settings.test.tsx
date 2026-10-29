// @vitest-environment jsdom

import type { RoleplayCharacter } from "@rakazo/contracts";
import { createRoleplayLorebookEntry } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleplayRelationshipDebug } from "../components/roleplay-relationship-debug";
import type { RoleplaySettingsHandle } from "../components/roleplay-settings";
import { RoleplaySettings } from "../components/roleplay-settings";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
    editable: boolean;
  }) =>
    createElement("input", {
      value,
      disabled: !editable,
      "aria-label": accessibilityLabel,
      onInput: (event: { currentTarget: HTMLInputElement }) =>
        onChangeText(event.currentTarget.value),
    }),
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityState,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel: string;
    accessibilityState: { expanded: boolean };
    onPress: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "aria-expanded": accessibilityState.expanded,
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock("./native", () => ({ native: { fill: "fill" }, useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? "")),
  }),
}));
vi.mock("./user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    disabled: boolean;
    onPress: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": accessibilityLabel ?? label, disabled, onClick: onPress },
      label,
    ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    disabled,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    disabled: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) =>
    createElement("button", {
      type: "button",
      "aria-label": accessibilityLabel,
      role: "switch",
      "aria-checked": value,
      disabled,
      onClick: () => onValueChange(!value),
    }),
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
        onChange: (event: { currentTarget: HTMLSelectElement }) =>
          onChange(event.currentTarget.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));

const initial: RoleplayCharacter = {
  name: "Aster",
  description: "An archivist",
  personality: "Patient",
  scenario: "A library",
  firstMessage: "Welcome",
  exampleDialogue: "Aster: Hello",
  systemPrompt: "Stay in character",
  postHistoryInstructions: "Continue",
  alternateGreetings: ["Preserved greeting"],
  lorebook: {
    name: "Library",
    description: "Locations",
    scanDepth: 2,
    tokenBudget: 2048,
    entries: [
      {
        ...createRoleplayLorebookEntry(),
        keys: ["hello, friend"],
        secondaryKeys: ["library"],
        content: "One",
      },
      { ...createRoleplayLorebookEntry(), keys: ["Remove me"], content: "Two" },
    ],
  },
};

describe("native roleplay settings", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onSave: Mock<ComponentProps<typeof RoleplaySettings>["onSave"]>;
  let props: ComponentProps<typeof RoleplaySettings>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    root = createRoot(host);
    onSave = vi.fn<ComponentProps<typeof RoleplaySettings>["onSave"]>(async (value) => value);
    props = { character: structuredClone(initial), onSave };
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  async function render(key = "bot-one") {
    await act(async () => root.render(<RoleplaySettings key={key} {...props} />));
  }
  function button(label: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
    expect(result, `button: ${label}`).toBeDefined();
    return result!;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  function input(label: string) {
    const result = [...host.querySelectorAll<HTMLInputElement>("input")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
    expect(result, `input: ${label}`).toBeDefined();
    return result!;
  }
  async function change(label: string, value: string) {
    await act(async () => {
      const target = input(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        target,
        value,
      );
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function stylePicker() {
    return host.querySelector<HTMLSelectElement>('select[aria-label="Conversation style"]')!;
  }
  async function changeStyle(value: string) {
    await act(async () => {
      const select = stylePicker();
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        value,
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("defaults legacy cards to narrative and preserves a missing style on unrelated saves", async () => {
    await render();
    expect(stylePicker().value).toBe("narrative");
    expect(host.textContent).not.toContain("Save changes");
    await change("Character description", "Edited");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("conversationStyle");
  });

  it("saves style with the full card and uses the accepted style as its baseline", async () => {
    await render();
    await changeStyle("chat");
    expect(onSave).not.toHaveBeenCalled();
    await click("Save changes");
    const saved = { ...initial, conversationStyle: "chat" };
    expect(onSave).toHaveBeenLastCalledWith(saved, initial);
    expect(host.textContent).not.toContain("Save changes");
    await changeStyle("narrative");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[1]).toEqual(saved);
  });

  it("discards a style draft and displays refreshed saved styles", async () => {
    await render();
    await changeStyle("chat");
    await click("Discard");
    expect(stylePicker().value).toBe("narrative");
    expect(onSave).not.toHaveBeenCalled();
    props.character = { ...initial, conversationStyle: "chat" };
    await render();
    expect(stylePicker().value).toBe("chat");
  });

  it("keeps spontaneous messages off and absent until explicitly enabled in chat", async () => {
    await render();
    expect(host.textContent).not.toContain("Spontaneous messages");
    await changeStyle("chat");
    expect(button("Spontaneous messages").getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("Late-night messages");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("spontaneous");
    await click("Spontaneous messages");
    const frequency = host.querySelector<HTMLSelectElement>('select[aria-label="Frequency"]')!;
    expect(frequency.value).toBe("balanced");
    expect(button("Late-night messages").getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      frequency.value = "gentle";
      frequency.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Late-night messages");
    expect(onSave).toHaveBeenCalledTimes(1);
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0].spontaneous).toEqual({
      enabled: true,
      frequency: "gentle",
      allowLateNight: true,
    });
    expect(onSave.mock.lastCall?.[1]).not.toHaveProperty("spontaneous");
  });

  it("discards spontaneous drafts and hides persisted preferences in narrative", async () => {
    const saved: RoleplayCharacter = {
      ...initial,
      conversationStyle: "chat",
      spontaneous: { enabled: true, frequency: "frequent", allowLateNight: false },
    };
    props.character = saved;
    await render();
    expect(host.textContent).not.toContain("Save changes");
    await click("Spontaneous messages");
    expect(host.textContent).not.toContain("Late-night messages");
    await click("Discard");
    expect(button("Spontaneous messages").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Frequency"]')!.value).toBe(
      "frequent",
    );
    await changeStyle("narrative");
    expect(host.textContent).not.toContain("Spontaneous messages");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0]).toEqual({ ...saved, conversationStyle: "narrative" });
  });

  it("loads relationship debug on expansion and saves scores with the loaded revision", async () => {
    const initialState = {
      relationship: { warmth: 20, intimacy: 30, love: 40 },
      historyGeneration: 3,
      revision: "revision-one",
    };
    const load = vi.fn(async () => initialState);
    const save = vi.fn(async (state: typeof initialState) => ({
      ...state,
      revision: "revision-two",
    }));
    await act(async () => root.render(<RoleplayRelationshipDebug onLoad={load} onSave={save} />));
    expect(load).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Warmth");
    await click("Relationship debug");
    expect(load).toHaveBeenCalledOnce();
    expect(input("Warmth").value).toBe("20");
    await change("Warmth", "");
    await click("Save changes");
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Enter whole numbers from 0 to 100.");
    await click("Discard");
    expect(input("Warmth").value).toBe("20");
    await change("Warmth", "80");
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(new Error("Relationship changed. Reload and try again."));
    await click("Save changes");
    expect(input("Warmth").value).toBe("80");
    expect(host.textContent).toContain("Relationship changed");
    await click("Save changes");
    expect(save).toHaveBeenLastCalledWith({
      ...initialState,
      relationship: { warmth: 80, intimacy: 30, love: 40 },
    });
    await change("Love", "100");
    await click("Save changes");
    expect(save.mock.lastCall?.[0].revision).toBe("revision-two");
  });

  async function openBook() {
    await click("Lorebook");
  }

  it("saves every character field canonically and preserves inactive alternate greetings", async () => {
    await render();
    await change("Character name", "  Aster edited  ");
    await change("Character description", "New description");
    await change("Personality", "Curious");
    await click("Story");
    await change("Scenario", "New story");
    await change("First message", "A new greeting");
    await change("Dialogue examples", "Example");
    await click("Narrative instructions");
    await change("System prompt", "New system");
    await change("Post-history instructions", "New ending");
    expect(onSave).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Changes apply next turn and keep history and memory");
    expect(host.textContent).not.toContain("alternateGreetings");
    await click("Save changes");
    const expected = {
      ...initial,
      name: "Aster edited",
      description: "New description",
      personality: "Curious",
      scenario: "New story",
      firstMessage: "A new greeting",
      exampleDialogue: "Example",
      systemPrompt: "New system",
      postHistoryInstructions: "New ending",
    };
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expected, initial);
    expect(input("Character name").value).toBe("Aster edited");
    expect(host.textContent).not.toContain("Save changes");
    await change("Personality", "Second edit");
    await click("Save changes");
    expect(onSave.mock.calls[1]![1]).toEqual(expected);
  });

  it("edits all lore fields, preserves comma keys and disabled flags, and deletes entries", async () => {
    await render();
    await openBook();
    await change("Lorebook name", "Edited book");
    await change("Lorebook description", "Edited metadata");
    await change("Scan depth", "0");
    await change("Token budget", "32768");
    await click("hello, friend");
    await change("Secondary keys 1", "new, phrase");
    await change("Entry content", "New lore");
    for (const label of ["Enabled", "Always active", "Require secondary match", "Case sensitive"])
      await click(label);
    await change("Insertion order", "-100000");
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Position"]')!;
      select.value = "after_char";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Collapse the first entry so the second remove action is unambiguous.
    await click("hello, friend");
    await click("Remove me");
    await click("Remove entry");
    await click("Save changes");
    expect(onSave.mock.calls[0]![0].lorebook).toEqual({
      name: "Edited book",
      description: "Edited metadata",
      scanDepth: 0,
      tokenBudget: 32768,
      entries: [
        {
          keys: ["hello, friend"],
          secondaryKeys: ["new, phrase"],
          content: "New lore",
          enabled: false,
          constant: true,
          selective: true,
          caseSensitive: true,
          insertionOrder: -100000,
          position: "after_char",
        },
      ],
    });
  });

  it.each(["", "1.5", "101", "bad"])(
    "rejects invalid numeric draft %j without turning it into zero",
    async (value) => {
      await render();
      await openBook();
      await change("Scan depth", value);
      await click("Save changes");
      expect(onSave).not.toHaveBeenCalled();
      expect(input("Scan depth").value).toBe(value);
      expect(host.textContent).toContain("Enter a whole number from 0 to 100.");
      await change("Scan depth", "0");
      await click("Save changes");
      expect(onSave.mock.calls[0]![0].lorebook!.scanDepth).toBe(0);
    },
  );

  it("retains rejected drafts and original conflict baseline across bot refresh, then explicitly discards", async () => {
    onSave.mockRejectedValue(
      new Error("Finish or stop the current turn before editing roleplay settings."),
    );
    await render();
    await change("Character name", "Local draft");
    await click("Save changes");
    expect(host.textContent).toContain("Finish or stop the current turn");
    props.character = { ...initial, name: "Saved elsewhere" };
    await render();
    expect(input("Character name").value).toBe("Local draft");
    await click("Save changes");
    expect(onSave.mock.calls[1]![1]).toEqual(initial);
    await click("Discard");
    expect(input("Character name").value).toBe("Saved elsewhere");
    expect(host.textContent).not.toContain("Finish or stop the current turn");
    expect(host.textContent).not.toContain("Save changes");
  });

  it("keeps a clean saved draft synchronized with background refresh and resets for another bot", async () => {
    await render();
    props.character = { ...initial, name: "Refreshed" };
    await render();
    expect(input("Character name").value).toBe("Refreshed");
    await change("Character name", "Unsaved");
    props.character = { ...initial, name: "Other bot" };
    await render("bot-two");
    expect(input("Character name").value).toBe("Other bot");
    expect(host.textContent).not.toContain("Save changes");
  });

  it("disables draft actions and suppresses duplicate writes while saving", async () => {
    let finish!: (value: RoleplayCharacter) => void;
    onSave.mockImplementation(
      () =>
        new Promise<RoleplayCharacter>((resolve) => {
          finish = resolve;
        }),
    );
    const ref = createRef<RoleplaySettingsHandle>();
    props.ref = ref;
    await render();
    await change("Character name", "Pending");
    await click("Save changes");
    expect(input("Character name").disabled).toBe(true);
    expect(button("Discard").disabled).toBe(true);
    expect(button("Saving…").disabled).toBe(true);
    await act(async () => {
      expect(await ref.current!.save()).toBe(false);
    });
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => finish({ ...initial, name: "Pending" }));
    // The parent normally updates the prop on save; simulate that canonical bot refresh.
    props.character = { ...initial, name: "Pending" };
    await render();
    expect(input("Character name").disabled).toBe(false);
    expect(host.textContent).not.toContain("Save changes");
  });

  it("adds and removes lorebook data only when saved, with literal key editing", async () => {
    props.character = { ...initial, lorebook: null };
    await render();
    await openBook();
    await click("Add lorebook");
    await click("Add entry");
    await click("Entry 1");
    await click("Add Primary keys");
    await change("Primary keys 1", "one, two");
    await click("Add Secondary keys");
    await change("Secondary keys 1", "secondary");
    await click("Remove Secondary keys 1");
    await click("Save changes");
    const saved = onSave.mock.calls[0]![0] as RoleplayCharacter;
    expect(saved.lorebook!.entries[0]!.keys).toEqual(["one, two"]);
    expect(saved.lorebook!.entries[0]!.secondaryKeys).toEqual([]);
    props.character = saved;
    await render();
    await click("Remove lorebook");
    expect(onSave).toHaveBeenCalledTimes(1);
    await click("Save changes");
    expect(onSave.mock.calls[1]![0].lorebook).toBeNull();
  });
});
