import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostBrowserScope } from "./host-browser.js";
import {
  browserKeyEvent,
  HostBrowserManager,
  hostBrowserUrl,
  resolveHostBrowserUploads,
} from "./host-browser.js";
import type { HostBrowserConnection } from "./host-browser-cdp.js";

const fixture = `<title>Offline browser</title><body><label>Name<input name="name"></label><input type="password"><select><option value="a">First</option><option value="b">Second</option></select><input type="file"><button>Continue</button></body>`;
class OfflineChrome implements HostBrowserConnection {
  readonly calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  readonly targets = new Map<string, JSDOM>();
  readonly close = vi.fn(async () => {
    for (const dom of this.targets.values()) dom.window.close();
  });
  private counter = 0;
  readonly openers = new Map<string, string>();
  private readonly events = new Set<
    (method: string, params: Record<string, unknown>, sessionId?: string) => void
  >();
  onEvent(event: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.events.add(event);
    return () => {
      this.events.delete(event);
    };
  }
  emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    for (const event of this.events) event(method, params, sessionId);
  }
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });
    let result: unknown = {};
    if (method === "Target.createTarget") {
      const id = `tab${++this.counter}`;
      const dom = new JSDOM(fixture, {
        url: String(params.url === "about:blank" ? "https://example.test/" : params.url),
        runScripts: "outside-only",
        pretendToBeVisual: true,
      });
      dom.window.Element.prototype.getBoundingClientRect = () => ({
        width: 100,
        height: 30,
        x: 0,
        y: 0,
        left: 0,
        right: 100,
        top: 0,
        bottom: 30,
        toJSON: () => ({}),
      });
      dom.window.Element.prototype.scrollIntoView = () => undefined;
      this.targets.set(id, dom);
      result = { targetId: id };
    } else if (method === "Target.getTargets")
      result = {
        targetInfos: [...this.targets].map(([targetId, dom]) => ({
          targetId,
          type: "page",
          title: dom.window.document.title,
          url: dom.window.location.href,
          openerId: this.openers.get(targetId),
        })),
      };
    else if (method === "Target.attachToTarget") result = { sessionId: params.targetId };
    else if (method === "Target.closeTarget") {
      this.targets.get(String(params.targetId))?.window.close();
      this.targets.delete(String(params.targetId));
      result = { success: true };
    } else if (method === "Page.getFrameTree") result = { frameTree: { frame: { id: sessionId } } };
    else if (method === "Page.createIsolatedWorld") result = { executionContextId: 1 };
    else if (method === "Page.handleJavaScriptDialog")
      this.emit("Page.javascriptDialogClosed", {}, sessionId);
    else if (method === "Runtime.evaluate") {
      const dom = this.targets.get(sessionId!)!;
      try {
        const value = dom.window.eval(String(params.expression));
        result = {
          result: {
            value,
            ...(params.returnByValue === false ? { objectId: "upload-target" } : {}),
          },
        };
      } catch {
        result = { result: {}, exceptionDetails: { text: "Do not echo scripts or credentials" } };
      }
    } else if (method === "Page.captureScreenshot")
      result = { data: Buffer.from("offline-jpeg").toString("base64") };
    else if (method === "Page.navigate")
      this.targets.get(sessionId!)!.reconfigure({ url: String(params.url) });
    else if (
      method === "Input.dispatchKeyEvent" &&
      params.type === "keyDown" &&
      typeof params.text === "string"
    ) {
      const el = this.targets.get(sessionId!)!.window.document.activeElement as HTMLInputElement;
      el.value += params.text;
    }
    return result as T;
  }
}
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-host-browser-test-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "bots", "one"), { recursive: true });
  await mkdir(path.join(workspace, "shared"));
  const connections: OfflineChrome[] = [];
  const launch = vi.fn(async () => {
    const browser = new OfflineChrome();
    connections.push(browser);
    return browser;
  });
  const manager = new HostBrowserManager({ root, launch });
  const scope: HostBrowserScope = {
    computerId: "computer",
    botId: "one",
    workspaceRoot: workspace,
    uploadRoots: ["bots/one", "shared"],
    downloadDirectory: path.join(workspace, "bots", "one", "Downloads"),
  };
  return { root, workspace, manager, scope, connections, launch };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed host browser", () => {
  it("uses real page refs for filling, typing, selections and protected saved logins", async () => {
    const { manager, scope, connections } = await setup();
    try {
      let snap = await manager.pageBrowser(scope, { command: "snapshot" });
      const name = snap.elements!.find((el) => el.name === "Name")!;
      const typed = await manager.pageBrowser(scope, {
        command: "act",
        actions: [{ kind: "type", ref: name.ref, text: "Ada" }],
      });
      expect(typed.ok).toBe(true);
      expect(typed.elements!.find((el) => el.name === "Name")?.value).toBe("Ada");
      expect(connections[0]!.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(
        true,
      );
      const select = typed.elements!.find((el) => el.tag === "select")!;
      snap = await manager.pageBrowser(scope, {
        command: "act",
        actions: [{ kind: "fill", ref: select.ref, text: "Second" }],
      });
      expect(snap.elements!.find((el) => el.tag === "select")?.value).toBe("b");
      const username = snap.elements!.find((el) => el.name === "Name")!;
      const login = await manager.pageBrowser(scope, {
        command: "act",
        actions: [
          {
            kind: "fill",
            ref: username.ref,
            text: "saved-username",
            origin: "https://example.test",
            field: "username",
          },
        ],
      });
      expect(login.ok).toBe(true);
      expect(login.elements!.find((el) => el.name === "Name")?.value).toBeUndefined();
      const field = login.elements!.find((el) => el.name === "Name")!;
      const refused = await manager.pageBrowser(scope, {
        command: "act",
        actions: [
          {
            kind: "fill",
            ref: field.ref,
            text: "saved-password",
            origin: "https://example.test",
            field: "password",
          },
        ],
      });
      expect(refused).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(refused.fallback).toBeUndefined();
      expect(JSON.stringify(refused)).not.toContain("saved-password");
    } finally {
      await manager.close();
    }
  });

  it("isolates bot profiles/tabs and closes only owned browser processes", async () => {
    const { manager, scope, connections, launch } = await setup();
    const other = { ...scope, botId: "two", downloadDirectory: undefined };
    const first = await manager.preview(scope, { action: "state" });
    const second = await manager.preview(other, { action: "state" });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0]).not.toEqual(launch.mock.calls[1]);
    await expect(
      manager.preview(scope, { action: "selectTab", tabId: "not-owned" }),
    ).rejects.toThrow("does not belong");
    await manager.preview(scope, { action: "newTab", url: "https://example.test/next" });
    expect((await manager.preview(scope, { action: "state" })).tabs).toHaveLength(
      first.tabs.length + 1,
    );
    expect((await manager.preview(other, { action: "state" })).tabs).toHaveLength(
      second.tabs.length,
    );
    await manager.stop(scope);
    expect(connections[0]!.close).toHaveBeenCalledOnce();
    expect(connections[1]!.close).not.toHaveBeenCalled();
    await manager.closeComputer(scope.computerId);
    expect(connections[1]!.close).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("preserves pointer drag buttons, uses scroll units and canonical keyboard modifiers", async () => {
    const { manager, scope, connections } = await setup();
    await manager.preview(scope, {
      action: "input",
      inputs: [
        { kind: "pointer", type: "down", x: 12, y: 34 },
        { kind: "pointer", type: "move", x: 45, y: 56 },
        { kind: "pointer", type: "up", x: 45, y: 56 },
        { kind: "scroll", direction: "down", amount: 3 },
        { kind: "key", key: "CTRL+A" },
      ],
    });
    const calls = connections[0]!.calls;
    expect(calls.find((call) => call.params.type === "mouseMoved")?.params.buttons).toBe(1);
    expect(calls.find((call) => call.params.type === "mouseWheel")?.params.deltaY).toBe(300);
    expect(calls.find((call) => call.params.type === "keyDown")?.params).toMatchObject({
      key: "A",
      modifiers: 2,
    });
    await manager.close();
  });

  it("bounds and confines downloads to host-authorized bot folders", async () => {
    const { manager, scope, connections } = await setup();
    await manager.screenshot(scope);
    const browser = connections[0]!;
    const config = browser.calls.find(
      (call) => call.method === "Browser.setDownloadBehavior",
    )!.params;
    expect(config).toMatchObject({ behavior: "allowAndName", eventsEnabled: true });
    expect(config.downloadPath).not.toBe(scope.downloadDirectory);
    browser.emit("Browser.downloadWillBegin", { guid: "local", url: "file:///private/file" });
    browser.emit("Browser.downloadProgress", { guid: "large", receivedBytes: 9 * 1024 * 1024 });
    expect(
      browser.calls
        .filter((call) => call.method === "Browser.cancelDownload")
        .map((call) => call.params.guid),
    ).toEqual(["local", "large"]);
    await writeFile(path.join(scope.downloadDirectory!, "report.txt"), "keep existing");
    browser.emit("Browser.downloadWillBegin", {
      guid: "allowed",
      url: "https://example.test/file",
      suggestedFilename: "report.txt",
    });
    await writeFile(path.join(String(config.downloadPath), "allowed"), "downloaded bytes");
    browser.emit("Browser.downloadProgress", {
      guid: "allowed",
      state: "completed",
      receivedBytes: 16,
    });
    await manager.close();
    expect(await readFile(path.join(scope.downloadDirectory!, "report.txt"), "utf8")).toBe(
      "keep existing",
    );
    expect(await readFile(path.join(scope.downloadDirectory!, "report (1).txt"), "utf8")).toBe(
      "downloaded bytes",
    );
  });

  it("stages uploaded bytes privately, rejects symlinks and never lets caller roots expand authority", async () => {
    const { manager, scope, workspace, connections } = await setup();
    const file = path.join(workspace, "bots", "one", "document.txt");
    await writeFile(file, "authorized bytes");
    const snap = await manager.pageBrowser(scope, { command: "snapshot" });
    const ref = snap.elements!.find((el) => el.role === "file upload")!.ref;
    const result = await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "upload", ref, paths: ["bots/one/document.txt"] }],
    });
    expect(result.ok).toBe(true);
    const staged = (
      connections[0]!.calls.find((call) => call.method === "DOM.setFileInputFiles")!.params
        .files as string[]
    )[0]!;
    expect(staged).not.toBe(file);
    expect(await readFile(staged, "utf8")).toBe("authorized bytes");
    await expect(
      resolveHostBrowserUploads(scope, {
        kind: "upload",
        ref,
        paths: ["bots/one/document.txt"],
        roots: ["."],
      }),
    ).rejects.toThrow("outside");
    const outside = path.join(workspace, "other");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(workspace, "bots", "one", "link"));
    await expect(
      resolveHostBrowserUploads(scope, {
        kind: "upload",
        ref,
        paths: ["bots/one/link/secret.txt"],
      }),
    ).rejects.toThrow("outside");
    await manager.stop(scope);
    await expect(readFile(staged)).rejects.toThrow();
    await manager.close();
  });

  it("exposes model tab controls, adopts owned popups and rejects another bot's target refs", async () => {
    const { manager, scope, connections } = await setup();
    let snapshot = await manager.pageBrowser(scope, { command: "snapshot" });
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "rakazo-tab-new" }),
        expect.objectContaining({ ref: "rakazo-tab:tab1" }),
      ]),
    );
    await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: "rakazo-tab-new" }],
    });
    expect((await manager.preview(scope, { action: "state" })).tabs).toHaveLength(2);
    await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: "rakazo-tab:tab1" }],
    });
    const chrome = connections[0]!;
    const popup = await chrome.call<{ targetId: string }>("Target.createTarget", {
      url: "https://example.test/popup",
    });
    chrome.openers.set(popup.targetId, "tab1");
    const state = await manager.preview(scope, { action: "state" });
    expect(state.tabs.find((tab) => tab.active)?.id).toBe(popup.targetId);
    snapshot = await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: "rakazo-tab:foreign" }],
    });
    expect(snapshot).toMatchObject({ ok: false, uncertain: false });
    expect(
      chrome.calls
        .filter((call) => call.method === "Target.closeTarget")
        .some((call) => call.params.targetId === "foreign"),
    ).toBe(false);
    await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: `rakazo-tab-close:${popup.targetId}` }],
    });
    expect((await manager.preview(scope, { action: "state" })).tabs).toHaveLength(2);
    await manager.close();
  });

  it("reports paused JavaScript dialogs without evaluating the page and handles prompt responses and keys", async () => {
    const { manager, scope, connections } = await setup();
    await manager.pageBrowser(scope, { command: "snapshot" });
    const chrome = connections[0]!;
    const before = chrome.calls.filter((call) => call.method === "Runtime.evaluate").length;
    chrome.emit(
      "Page.javascriptDialogOpening",
      { type: "prompt", message: "Your response", defaultPrompt: "Initial" },
      "tab1",
    );
    const snapshot = await manager.pageBrowser(scope, { command: "snapshot" });
    expect(snapshot.tree).toContain('prompt dialog: "Your response"');
    expect(
      snapshot.elements!.find((element) => element.ref.startsWith("rakazo-dialog-text:"))?.value,
    ).toBe("Initial");
    expect(chrome.calls.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(before);
    const state = await manager.preview(scope, { action: "state" });
    expect(state.dialog).toEqual({
      id: expect.any(String),
      type: "prompt",
      message: "Your response",
      defaultPrompt: "Initial",
    });
    const refused = await manager.pageBrowser(scope, {
      command: "act",
      actions: [
        {
          kind: "fill",
          ref: `rakazo-dialog-text:${state.dialog!.id}`,
          text: "secret",
          origin: "https://example.test",
          field: "password",
        },
      ],
    });
    expect(refused).toMatchObject({ ok: false, uncertain: false });
    expect(JSON.stringify(refused)).not.toContain("secret");
    await manager.computerAct(scope, {
      actions: [
        { kind: "clipboard", text: "Answer" },
        { kind: "key", key: "ENTER" },
      ],
    });
    expect(
      chrome.calls.find((call) => call.method === "Page.handleJavaScriptDialog")?.params,
    ).toEqual({ accept: true, promptText: "Answer" });
    chrome.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Continue?" }, "tab1");
    await manager.computerAct(scope, { actions: [{ kind: "key", key: "ESCAPE" }] });
    expect(
      chrome.calls.filter((call) => call.method === "Page.handleJavaScriptDialog").at(-1)?.params,
    ).toEqual({ accept: false });
    chrome.emit("Page.javascriptDialogOpening", { type: "alert", message: "Notice" }, "tab1");
    await manager.preview(scope, {
      action: "dialog",
      dialogId: (await manager.preview(scope, { action: "state" })).dialog!.id,
      accept: true,
    });
    expect((await manager.preview(scope, { action: "state" })).dialog).toBeUndefined();
    chrome.emit("Page.javascriptDialogOpening", { type: "alert", message: "Foreign" }, "not-owned");
    expect((await manager.preview(scope, { action: "state" })).dialog).toBeUndefined();
    await manager.close();
  });

  it("interrupts an in-flight renderer query when a dialog opens and fences stale dialog answers", async () => {
    const { manager, scope, connections } = await setup();
    await manager.pageBrowser(scope, { command: "snapshot" });
    const chrome = connections[0]!;
    const original = chrome.call.bind(chrome);
    let blocked = true;
    chrome.call = async (method, params, sessionId) => {
      if (method === "Page.getFrameTree" && blocked) {
        blocked = false;
        queueMicrotask(() =>
          chrome.emit(
            "Page.javascriptDialogOpening",
            { type: "confirm", message: "Same" },
            sessionId,
          ),
        );
        return new Promise(() => undefined);
      }
      return original(method, params, sessionId);
    };
    const snapshot = await manager.pageBrowser(scope, { command: "snapshot" });
    expect(snapshot.tree).toContain('confirm dialog: "Same"');
    const first = (await manager.preview(scope, { action: "state" })).dialog!;
    chrome.emit("Page.javascriptDialogClosed", {}, "tab1");
    chrome.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Same" }, "tab1");
    const current = (await manager.preview(scope, { action: "state" })).dialog!;
    expect(current.id).not.toBe(first.id);
    await expect(
      manager.preview(scope, { action: "dialog", dialogId: first.id, accept: true }),
    ).rejects.toThrow("changed");
    const stale = await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: `rakazo-dialog-accept:${first.id}` }],
    });
    expect(stale).toMatchObject({ ok: false, uncertain: false });
    expect(
      chrome.calls.filter((call) => call.method === "Page.handleJavaScriptDialog"),
    ).toHaveLength(0);
    const image = await manager.screenshot(scope);
    expect(Buffer.from(image.data, "base64").subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    await manager.close();
  });

  it("reports uncertain dialog acceptance when its response is lost", async () => {
    const { manager, scope, connections } = await setup();
    await manager.pageBrowser(scope, { command: "snapshot" });
    const chrome = connections[0]!;
    chrome.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Continue?" }, "tab1");
    const dialog = (await manager.preview(scope, { action: "state" })).dialog!;
    const original = chrome.call.bind(chrome);
    chrome.call = async (method, params, sessionId) => {
      if (method === "Page.handleJavaScriptDialog") {
        chrome.emit("Page.javascriptDialogClosed", {}, sessionId);
        throw new Error("Lost response");
      }
      return original(method, params, sessionId);
    };
    const result = await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "click", ref: `rakazo-dialog-accept:${dialog.id}` }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: true });
    await manager.close();
  });

  it("reports a dispatched upload with a lost response as uncertain", async () => {
    const { manager, scope, workspace, connections } = await setup();
    await writeFile(path.join(workspace, "bots", "one", "document.txt"), "bytes");
    const snap = await manager.pageBrowser(scope, { command: "snapshot" });
    const ref = snap.elements!.find((element) => element.role === "file upload")!.ref;
    const chrome = connections[0]!;
    const original = chrome.call.bind(chrome);
    chrome.call = async (method, params, sessionId) => {
      if (method === "DOM.setFileInputFiles") throw new Error("Lost browser response");
      return original(method, params, sessionId);
    };
    const result = await manager.pageBrowser(scope, {
      command: "act",
      actions: [{ kind: "upload", ref, paths: ["bots/one/document.txt"] }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: true });
    await manager.close();
  });

  it("rejects profile symlinks and cancels queued work before stopped scopes can recreate browsers", async () => {
    const { manager, scope, root, launch } = await setup();
    const original = await manager.preview(scope, { action: "state" });
    expect(original.tabs).toHaveLength(1);
    const pending = manager.preview(scope, { action: "state" });
    const stop = manager.stop(scope);
    await expect(pending).rejects.toThrow("stopped");
    await stop;
    expect(launch).toHaveBeenCalledOnce();
    await manager.close();
    const redirect = path.join(root, "outside-profiles");
    await mkdir(redirect);
    const maliciousRoot = path.join(root, "malicious");
    await mkdir(maliciousRoot);
    await symlink(redirect, path.join(maliciousRoot, "managed-browser-profiles"));
    const unsafe = new HostBrowserManager({ root: maliciousRoot, launch });
    await expect(unsafe.preview(scope, { action: "state" })).rejects.toThrow("symbolic links");
    expect(launch).toHaveBeenCalledOnce();
    await unsafe.close();
  });
});

it("allows ordinary HTTP pages but refuses host file/internal navigation and maps keyboard shortcuts", () => {
  expect(hostBrowserUrl("http://example.test/path")).toBe("http://example.test/path");
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
    "https://name:password@example.test",
  ])
    expect(() => hostBrowserUrl(url)).toThrow();
  expect(browserKeyEvent("Backspace", ["Meta"])).toMatchObject({ key: "Backspace", modifiers: 4 });
  expect(browserKeyEvent("a", ["Control", "Shift"])).toMatchObject({ key: "a", modifiers: 10 });
});
