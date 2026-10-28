// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ directories: vi.fn(), scope: 0 }));
vi.mock("../../lib/space-rpc", () => {
  const client = { hosts: api };
  const otherSpace = { hosts: api };
  return { useSpaceRpc: () => (api.scope === 0 ? client : otherSpace) };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ProjectFolderPicker } from "./project-folder-picker";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  api.scope = 0;
});
async function fixture() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const changed = vi.fn();
  async function render(hostId: string | null = null) {
    await act(async () => {
      root.render(
        <ProjectFolderPicker
          id="project"
          hostId={hostId}
          value="/home/test/project"
          onChange={changed}
        />,
      );
    });
  }
  await render();
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  async function click(label: string) {
    await act(async () => {
      button(label).click();
    });
  }
  return { container, changed, render, button, click };
}
const home = {
  path: "/home/test",
  parent: null,
  directories: [{ name: "project", path: "/home/test/project" }],
  truncated: false,
};
const project = {
  path: "/home/test/project",
  parent: "/home/test",
  directories: [],
  truncated: false,
};
it("navigates on the selected host and commits only Use folder", async () => {
  api.directories
    .mockResolvedValueOnce(project)
    .mockResolvedValueOnce(home)
    .mockResolvedValueOnce(project);
  const f = await fixture();
  await f.render("registered");
  await f.click("Browse");
  expect(api.directories).toHaveBeenLastCalledWith({
    hostId: "registered",
    path: "/home/test/project",
  });
  expect(f.container.textContent).toContain("No folders");
  await f.click("Up");
  await f.click("project");
  expect(f.changed).not.toHaveBeenCalled();
  await f.click("Use folder");
  expect(f.changed).toHaveBeenCalledExactlyOnceWith("/home/test/project");
  expect(f.container.querySelector('[role="dialog"]')).toBeNull();
});
it("cancels navigation without changing the manual project path", async () => {
  api.directories.mockResolvedValueOnce(project).mockResolvedValueOnce(home);
  const f = await fixture();
  await f.click("Browse");
  await f.click("Up");
  await f.click("Cancel");
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLInputElement>("#project")!.value).toBe("/home/test/project");
});
it("closes and discards an in-flight listing when the selected host changes", async () => {
  let complete: (value: typeof home) => void = () => {};
  api.directories
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(project);
  const f = await fixture();
  await f.click("Browse");
  expect(f.container.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!.disabled).toBe(
    true,
  );
  await f.render("other-host");
  await act(async () => {
    complete(home);
  });
  expect(f.container.querySelector('[role="dialog"]')).toBeNull();
  await f.click("Browse");
  expect(api.directories).toHaveBeenLastCalledWith({
    hostId: "other-host",
    path: "/home/test/project",
  });
  expect(f.button("project")).toBeUndefined();
  expect(f.changed).not.toHaveBeenCalled();
});
it("discards late results after cancellation and keeps unavailable paths editable", async () => {
  let complete: (value: typeof home) => void = () => {};
  api.directories
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("denied"));
  const f = await fixture();
  await f.click("Browse");
  await f.click("Cancel");
  await act(async () => {
    complete(home);
  });
  await f.click("Browse");
  expect(f.container.querySelector('[role="alert"]')!.textContent).toContain(
    "Could not open folder",
  );
  expect(f.button("Use folder").disabled).toBe(true);
  expect(f.container.querySelector<HTMLInputElement>("#project")!.value).toBe("/home/test/project");
  expect(f.changed).not.toHaveBeenCalled();
});

it("discards an old Space response after RPC identity changes", async () => {
  let complete: (value: typeof home) => void = () => {};
  api.directories
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(project);
  const f = await fixture();
  await f.click("Browse");
  api.scope = 1;
  await f.render();
  await act(async () => {
    complete(home);
  });
  expect(f.container.querySelector('[role="dialog"]')).toBeNull();
  await f.click("Browse");
  expect(f.button("project")).toBeUndefined();
  expect(f.changed).not.toHaveBeenCalled();
});
