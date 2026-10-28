// @vitest-environment jsdom
import type { RoleplayCharacter } from "@rakazo/contracts";
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

import { RoleplaySettings } from "./roleplay-settings";

const initial: RoleplayCharacter = {
  name: "Mira",
  description: "Cartographer",
  personality: "Curious",
  scenario: "A harbor",
  firstMessage: "Hello",
  exampleDialogue: "Example",
  systemPrompt: "Direction",
  postHistoryInstructions: "Reminder",
  alternateGreetings: ["Keep this greeting"],
  lorebook: {
    name: "Islands",
    description: "Coastal lore",
    scanDepth: 4,
    tokenBudget: 2048,
    entries: [
      {
        keys: ["harbor, east", "  spaces  "],
        secondaryKeys: ["tide"],
        content: "A hidden harbor",
        enabled: false,
        constant: false,
        selective: true,
        caseSensitive: true,
        insertionOrder: -1,
        position: "after_char",
      },
      {
        keys: ["island"],
        secondaryKeys: [],
        content: "An island",
        enabled: true,
        constant: true,
        selective: false,
        caseSensitive: false,
        insertionOrder: 3,
        position: "before_char",
      },
    ],
  },
};
let root: Root;
let container: HTMLDivElement;
let onSave: ReturnType<
  typeof vi.fn<(character: RoleplayCharacter, expected: RoleplayCharacter) => Promise<void>>
>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onSave = vi.fn(async () => undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(character = initial, botId = "bot-one", status = "idle") {
  await act(async () =>
    root.render(
      <RoleplaySettings character={character} botId={botId} status={status} onSave={onSave} />,
    ),
  );
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const element = [...container.querySelectorAll("label")].find(
    (value) => value.textContent === label,
  );
  const input = element
    ? document.getElementById(element.htmlFor)
    : container.querySelector(`[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing field ${label}`);
  return input as HTMLInputElement;
}
async function change(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => button.click());
}
async function toggle(label: string) {
  await act(async () => (field(label) as unknown as HTMLButtonElement).click());
}

describe("RoleplaySettings", () => {
  it("saves every active character field and preserves alternate greetings and literal key phrases", async () => {
    await render();
    for (const [label, value] of [
      ["Character name", "Lyra"],
      ["Description", "New description"],
      ["Personality", "New personality"],
      ["Scenario", "New scenario"],
      ["First message", "New greeting"],
      ["Dialogue examples", "New examples"],
      ["System prompt", "New direction"],
      ["Post-history instructions", "New reminder"],
    ])
      await change(label!, value!);
    expect(onSave).not.toHaveBeenCalled();
    await click("Save changes");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      {
        ...initial,
        name: "Lyra",
        description: "New description",
        personality: "New personality",
        scenario: "New scenario",
        firstMessage: "New greeting",
        exampleDialogue: "New examples",
        systemPrompt: "New direction",
        postHistoryInstructions: "New reminder",
      },
      initial,
    );
    expect(container.textContent).not.toContain("Save changes");
    await change("Scenario", "Later scenario");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[1].name).toBe("Lyra");
  });

  it("edits lore flags, metadata, content, keys, numbers and placement without changing other entries", async () => {
    await render();
    await change("Lorebook name", "New book");
    await change("Lorebook description", "New lore");
    await change("Scan depth", "0");
    await change("Token budget", "0");
    await change("Content", "Updated harbor");
    await change("Primary keys 1", "port, west");
    await change("Insertion order", "-100000");
    await change("Position", "before_char");
    for (const label of ["Enabled", "Always active", "Require secondary match", "Case sensitive"])
      await toggle(label);
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0].lorebook).toEqual({
      ...initial.lorebook,
      name: "New book",
      description: "New lore",
      scanDepth: 0,
      tokenBudget: 0,
      entries: [
        {
          ...initial.lorebook!.entries[0],
          content: "Updated harbor",
          keys: ["port, west", "  spaces  "],
          insertionOrder: -100000,
          position: "before_char",
          enabled: true,
          constant: true,
          selective: false,
          caseSensitive: false,
        },
        initial.lorebook!.entries[1],
      ],
    });
  });

  it("adds and removes lorebook entries and shifts numeric drafts with the remaining entry", async () => {
    await render();
    const order = container.querySelectorAll<HTMLInputElement>('[id$="insertionOrder"]')[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(order, "42");
      order.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Remove entry");
    await click("Add entry");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0].lorebook?.entries).toHaveLength(2);
    expect(onSave.mock.lastCall?.[0].lorebook?.entries[0]).toEqual({
      ...initial.lorebook!.entries[1],
      insertionOrder: 42,
    });
    expect(onSave.mock.lastCall?.[0].lorebook?.entries[1]?.enabled).toBe(true);
  });

  it("adds a lorebook to a character without one and removes it explicitly", async () => {
    const empty = { ...initial, lorebook: null };
    await render(empty);
    await click("Add lorebook");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0].lorebook).toMatchObject({
      scanDepth: 2,
      tokenBudget: 2048,
      entries: [],
    });
    await click("Remove lorebook");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[0].lorebook).toBeNull();
  });

  it.each(["", "1.5", "-1", "101", "no"])(
    "rejects invalid scan depth %j without coercing it",
    async (value) => {
      await render();
      await change("Scan depth", value);
      await click("Save changes");
      expect(onSave).not.toHaveBeenCalled();
      expect(field("Scan depth").value).toBe(value);
      expect(field("Scan depth").getAttribute("aria-invalid")).toBe("true");
      expect(container.textContent).toContain("Enter a whole number from 0 to 100.");
    },
  );

  it.each([
    ["Token budget", "32769"],
    ["Insertion order", "100001"],
    ["Insertion order", "-100001"],
  ])("rejects out of range %s", async (label, value) => {
    await render();
    await change(label!, value!);
    await click("Save changes");
    expect(onSave).not.toHaveBeenCalled();
    expect(field(label!).getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the draft and immutable baseline when saving fails, and retries", async () => {
    onSave.mockRejectedValueOnce(new Error("Stop the roleplay bot before replacing its character"));
    await render();
    await change("Description", "Unsaved edit");
    await click("Save changes");
    expect(field("Description").value).toBe("Unsaved edit");
    expect(container.textContent).toContain("Stop the roleplay bot");
    await click("Save changes");
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.lastCall?.[1]).toEqual(initial);
  });

  it.each(["queued", "leased", "running", "waiting_input", "waiting_takeover"])(
    "keeps edits while %s and saves once idle",
    async (status) => {
      await render(initial, "bot-one", status);
      await change("Description", "Draft");
      await click("Save changes");
      expect(onSave).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Stop the current reply");
      await render();
      await click("Save changes");
      expect(onSave).toHaveBeenCalledTimes(1);
    },
  );

  it("prevents duplicate saves while pending", async () => {
    let resolve!: () => void;
    onSave.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await render();
    await change("Description", "Pending");
    await click("Save changes");
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.textContent).toContain("Saving…");
    await act(async () => resolve());
    expect(container.textContent).not.toContain("Save changes");
  });

  it("refreshes pristine cards and keeps a dirty card until discarded", async () => {
    await render();
    await render({ ...initial, description: "Server version" });
    expect(field("Description").value).toBe("Server version");
    await change("Description", "My draft");
    const remote = { ...initial, description: "Newer server version" };
    await render(remote);
    expect(field("Description").value).toBe("My draft");
    await click("Save changes");
    expect(onSave.mock.lastCall?.[1].description).toBe("Server version");
    await change("Description", "Another draft");
    await click("Discard");
    expect(field("Description").value).toBe("Newer server version");
  });

  it("starts a separate draft on a new bot", async () => {
    await render();
    await change("Description", "Old bot draft");
    await render({ ...initial, name: "Nova", description: "New bot" }, "bot-two");
    expect(field("Character name").value).toBe("Nova");
    expect(field("Description").value).toBe("New bot");
    expect(container.textContent).not.toContain("Save changes");
  });
});

it("uses the API's canonical name for subsequent optimistic baselines", async () => {
  await render();
  await change("Character name", "  Lyra  ");
  onSave.mockImplementationOnce(async (saved) => {
    root.render(
      <RoleplaySettings
        character={{ ...saved, name: saved.name.trim() }}
        botId="bot-one"
        status="idle"
        onSave={onSave}
      />,
    );
    await Promise.resolve();
  });
  await click("Save changes");
  expect(onSave.mock.lastCall?.[0].name).toBe("Lyra");
  expect(field("Character name").value).toBe("Lyra");
  await change("Scenario", "Another day");
  await click("Save changes");
  expect(onSave.mock.lastCall?.[1].name).toBe("Lyra");
  expect(onSave.mock.lastCall?.[0].alternateGreetings).toEqual(initial.alternateGreetings);
  expect(onSave.mock.lastCall?.[0].lorebook?.entries[0]?.keys).toEqual([
    "harbor, east",
    "  spaces  ",
  ]);
});
