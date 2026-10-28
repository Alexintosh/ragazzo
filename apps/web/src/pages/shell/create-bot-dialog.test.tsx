// @vitest-environment jsdom

import { ORGANIC_AVATAR_LOOKS } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateBotDialogInput } from "./create-bot-dialog";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { CreateBotDialog } from "./create-bot-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onCreate: (input: CreateBotDialogInput) => Promise<void>) {
  await act(async () => {
    root.render(<CreateBotDialog onCancel={() => undefined} onCreate={onCreate} />);
  });
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("CreateBotDialog", () => {
  it("creates only once the name is not blank", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(onCreate);
    expect(button("Create").disabled).toBe(true);
    await typeName("   ");
    expect(button("Create").disabled).toBe(true);
    await typeName("  Scout  ");
    expect(button("Create").disabled).toBe(false);
  });

  it("sends the organic family the preview draws", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("Shape 2"));
    await click(button("Color #10B981"));
    const preview = document.querySelector(".rakazo-organic-avatar");
    const family = Number(preview?.getAttribute("data-shape-family"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Scout",
      color: "#10B981",
      avatarFamily: family,
    });
    expect(family).toBe(ORGANIC_AVATAR_LOOKS[1]);
  });

  it("sends a studio shape without an organic family", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("Color #F97316"));
    await click(button("wedge"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate).toHaveBeenCalledWith({ name: "Scout", color: "#F97316::shape_1" });
  });

  it.each(["codex", "claude", "acp"] as const)(
    "submits %s and project atomically without silently broadening access",
    async (runtimeKind) => {
      const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
      await render(onCreate);
      await typeName("Coder");
      await click(button("Agent and environment"));
      await act(async () => {
        const select = document.querySelector<HTMLSelectElement>('select[id$="-runtime"]')!;
        select.value = runtimeKind;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const permission = document.querySelector<HTMLSelectElement>('select[id$="-permission"]')!;
      expect(permission.value).toBe("workspace");
      if (runtimeKind !== "codex") {
        expect(
          permission.querySelector<HTMLOptionElement>('option[value="workspace"]')?.disabled,
        ).toBe(true);
        await act(async () => {
          permission.value = "full";
          permission.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      await act(async () => {
        const project = document.querySelector<HTMLInputElement>(
          'input[placeholder="Absolute path on host"]',
        )!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          project,
          "/projects/example",
        );
        project.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button("Create"));
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Coder",
          runtimeKind,
          executionTarget: "host",
          runtimePermission: runtimeKind === "codex" ? "workspace" : "full",
          projectPath: "/projects/example",
          computerMode: "team",
        }),
      );
    },
  );

  it("shows the error and stays open when creating fails", async () => {
    await render(async () => {
      throw new Error("Bot limit reached");
    });
    await typeName("Scout");
    await click(button("Create"));
    expect(document.querySelector('[data-testid="create-bot-error"]')?.textContent).toBe(
      "Bot limit reached",
    );
    expect(document.querySelector('[data-testid="create-bot-dialog"]')).not.toBeNull();
  });
});

describe("importing instead", () => {
  it("offers Import only when the parent handles it", async () => {
    await render(async () => undefined);
    expect(document.querySelector('[data-testid="create-bot-import"]')).toBeNull();

    const onImport = vi.fn();
    await act(async () => {
      root.render(
        <CreateBotDialog
          onCancel={() => undefined}
          onCreate={async () => undefined}
          onImport={onImport}
        />,
      );
    });
    await act(async () => button("Import").click());
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});

async function importJson(text: string, size = text.length) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = { name: "character.json", size, text: async () => text };
  await act(async () => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Roleplay creation", () => {
  it("requires an imported character and omits all operational settings", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await typeName("Aster");
    await click(button("Agent and environment"));
    await click(button("Roleplay"));
    expect(button("Create").disabled).toBe(true);
    expect(document.querySelector('select[id$="-runtime"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Agent and environment");
    await importJson(JSON.stringify({ name: "Aster", description: "A friendly archivist" }));
    expect(button("Create").disabled).toBe(false);
    await click(button("Create"));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        botKind: "roleplay",
        name: "Aster",
        runtimeKind: "pi",
        executionTarget: "docker",
        computerMode: "dedicated",
        registeredHostId: null,
        projectPath: null,
        roleplayCharacter: expect.objectContaining({
          name: "Aster",
          description: "A friendly archivist",
        }),
      }),
    );
  });

  it("fills an empty name, shows unsupported feature warnings, and resets import on toggle", async () => {
    await render(async () => undefined);
    await click(button("Roleplay"));
    await importJson(JSON.stringify({ name: "Aster", scripts: ["ignored"] }));
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')?.value,
    ).toBe("Aster");
    expect(document.querySelector('[aria-label="Import warnings"]')?.textContent).toContain(
      "not imported",
    );
    await click(button("Roleplay"));
    expect(button("Create").disabled).toBe(false);
    await click(button("Roleplay"));
    expect(button("Create").disabled).toBe(true);
  });

  it("rejects malformed and oversized JSON without allowing submission", async () => {
    await render(async () => undefined);
    await typeName("Aster");
    await click(button("Roleplay"));
    await importJson("{broken");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Create").disabled).toBe(true);
    await importJson('{"name":"Aster"}', 1024 * 1024 + 1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("1 MB");
    expect(button("Create").disabled).toBe(true);
  });

  it("ignores an older file read after a replacement or toggle", async () => {
    await render(async () => undefined);
    await click(button("Roleplay"));
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [{ name: "old.json", size: 20, text: () => pending }],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await importJson('{"name":"New character"}');
    await act(async () => {
      resolve('{"name":"Old character"}');
    });
    expect(document.body.textContent).not.toContain("Old character");
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')?.value,
    ).toBe("New character");
  });
});
