import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserActStep,
  BrowserSnapshotNode,
  ComputerAction,
  ComputerActionRequest,
  PageBrowserCommand,
  PageBrowserResult,
} from "@rakazo/adapter-kit";
import sharp from "sharp";
import { openContainedWorkspaceFile } from "./desktop-sandbox.js";
import { fileHandlePath } from "./file-handle-path.js";
import type { HostBrowserConnection } from "./host-browser-cdp.js";
import { findHostBrowserExecutable, launchHostBrowser } from "./host-browser-cdp.js";
import { HOST_BROWSER_PAGE_HELPERS } from "./host-browser-page.js";

export interface HostBrowserScope {
  computerId: string;
  botId: string;
  /** Trusted host workspace and authorized upload roots, reconstructed by the server. */
  workspaceRoot?: string;
  uploadRoots?: string[];
  downloadDirectory?: string;
}
export type HostBrowserPreviewCommand =
  | { action: "state" | "back" | "forward" | "reload" }
  | { action: "navigate"; url: string }
  | { action: "newTab"; url?: string }
  | { action: "selectTab" | "closeTab"; tabId: string }
  | { action: "input"; inputs: ComputerAction[] }
  | { action: "dialog"; dialogId: string; accept: boolean; text?: string };
export interface HostBrowserImage {
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}
export interface HostBrowserDialog {
  id: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}
export interface HostBrowserPreview {
  tabs: { id: string; title: string; url: string; active: boolean }[];
  image: HostBrowserImage;
  dialog?: HostBrowserDialog;
}
interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  openerId?: string;
}
interface BrowserRecord {
  computerId: string;
  connection: HostBrowserConnection;
  profile: string;
  unsubscribe?: () => void;
  downloadStaging?: string;
  downloadTasks: Set<Promise<void>>;
}
interface BotSession {
  browserKey: string;
  computerId: string;
  botId: string;
  targets: Map<string, string | undefined>;
  active: string;
  staging: string[];
  buttons: Map<string, number>;
  dialogs: Map<string, HostBrowserDialog & { promptText?: string }>;
  images: Map<string, HostBrowserImage>;
}
interface Page {
  connection: HostBrowserConnection;
  sessionId: string;
}
interface RemoteResult {
  result: { value?: unknown; objectId?: string };
  exceptionDetails?: unknown;
}
const WIDTH = 1280;
const HEIGHT = 800;
class BrowserRefusal extends Error {}
class BrowserDialogPending extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeKey = (scope: HostBrowserScope) => JSON.stringify([scope.computerId, scope.botId]);
const browserKey = (scope: HostBrowserScope) => JSON.stringify([scope.computerId, scope.botId]);

/** Reject local files and browser-internal schemes at every navigation boundary. */
export function hostBrowserUrl(value: string): string {
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter an HTTP or HTTPS URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter an HTTP or HTTPS URL without embedded credentials");
  return url.href;
}

export async function resolveHostBrowserUploads(
  scope: HostBrowserScope,
  action: Extract<BrowserActStep, { kind: "upload" }>,
): Promise<string[]> {
  if (!scope.workspaceRoot || !scope.uploadRoots?.length)
    throw new Error("Browser uploads are not authorized for this workspace");
  if (!action.paths.length || action.paths.length > 10)
    throw new Error("Upload requires 1 to 10 files");
  const workspace = await realpath(scope.workspaceRoot);
  const trusted: string[] = [];
  for (const root of scope.uploadRoots) {
    const expected = path.resolve(workspace, root);
    const actual = await realpath(expected).catch(() => undefined);
    // A symlink cannot silently redirect a trusted bot root into another bot's private folder.
    if (actual && actual === expected && contains(workspace, actual)) trusted.push(actual);
  }
  if (!trusted.length) throw new Error("Browser uploads are not authorized for this workspace");
  // Agent-supplied roots may narrow trusted authority; they never expand it.
  const narrowed: string[] = [];
  if (action.roots) {
    for (const root of action.roots) {
      const expected = path.resolve(workspace, root);
      const actual = await realpath(expected).catch(() => undefined);
      if (
        path.isAbsolute(root) ||
        !actual ||
        actual !== expected ||
        !trusted.some((parent) => contains(parent, actual))
      )
        throw new Error("Upload root is outside the authorized workspace");
      narrowed.push(actual);
    }
  }
  const roots = action.roots ? narrowed : trusted;
  const files: string[] = [];
  let bytes = 0;
  for (const requested of action.paths) {
    const file = await realpath(path.resolve(workspace, requested)).catch(() => undefined);
    if (!file || !roots.some((root) => contains(root, file)))
      throw new Error("Upload file is outside the authorized workspace or unavailable");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Upload requires regular files");
    bytes += info.size;
    if (bytes > 32 * 1024 * 1024) throw new Error("Upload files exceed 32 MB");
    files.push(file);
  }
  return files;
}
function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  expected: number,
  limit: number,
) {
  if (expected > limit) throw new Error("Browser file exceeds its size limit");
  const buffer = Buffer.alloc(expected + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== expected) throw new Error("Browser file changed while reading");
  return buffer.subarray(0, offset);
}

/** Managed browser state is private to this host bridge; no desktop browser is ever attached. */
export class HostBrowserManager {
  private readonly browsers = new Map<string, BrowserRecord>();
  private readonly sessions = new Map<string, BotSession>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private closing = false;
  private readonly closingScopes = new Set<string>();
  private readonly closingComputers = new Set<string>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly options: {
      root: string;
      executablePath?: string;
      /** Offline transport seam. Production always owns the installed browser process. */
      launch?: (profile: string) => Promise<HostBrowserConnection>;
    },
  ) {}

  async available() {
    if (this.options.launch || this.options.executablePath) return true;
    try {
      await findHostBrowserExecutable();
      return true;
    } catch {
      return false;
    }
  }

  private async serial<T>(scope: HostBrowserScope, work: () => Promise<T>): Promise<T> {
    const identity = scopeKey(scope);
    if (
      this.closing ||
      this.closingScopes.has(identity) ||
      this.closingComputers.has(scope.computerId)
    )
      throw new Error("Managed browsers are closing");
    const generation = this.generations.get(identity) ?? 0;
    const key = browserKey(scope);
    const before = this.tails.get(key) ?? Promise.resolve();
    const task = before
      .catch(() => undefined)
      .then(() => {
        if (generation !== (this.generations.get(identity) ?? 0))
          throw new Error("Managed browser session was stopped");
        return work();
      });
    this.tails.set(key, task);
    try {
      return await task;
    } finally {
      if (this.tails.get(key) === task) this.tails.delete(key);
    }
  }

  private async session(scope: HostBrowserScope): Promise<BotSession> {
    const key = scopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing && existing.browserKey !== browserKey(scope)) {
      await this.removeSession(key, existing);
    } else if (existing) return existing;
    const profileKey = browserKey(scope);
    let browser = this.browsers.get(profileKey);
    if (!browser) {
      const profile = path.join(this.options.root, "managed-browser-profiles", hash(profileKey));
      await this.privateDirectory(profile);
      const directory = await this.downloadDirectory(scope);
      let downloadStaging: string | undefined;
      if (directory) {
        const stagingRoot = path.join(this.options.root, "managed-browser-downloads");
        await this.privateDirectory(stagingRoot);
        downloadStaging = await mkdtemp(path.join(stagingRoot, "download-"));
      }
      let connection: HostBrowserConnection;
      try {
        connection = await (this.options.launch?.(profile) ??
          launchHostBrowser(profile, this.options.executablePath));
      } catch (error) {
        if (downloadStaging) await rm(downloadStaging, { recursive: true, force: true });
        throw error;
      }
      try {
        await connection.call(
          "Browser.setDownloadBehavior",
          downloadStaging
            ? { behavior: "allowAndName", downloadPath: downloadStaging, eventsEnabled: true }
            : { behavior: "deny" },
        );
      } catch (error) {
        await connection.close();
        if (downloadStaging) await rm(downloadStaging, { recursive: true, force: true });
        throw error;
      }
      const downloads = new Map<string, string>();
      const downloadTasks = new Set<Promise<void>>();
      const unsubscribe = connection.onEvent?.((method, params, sessionId) => {
        if (method === "Page.javascriptDialogOpening" || method === "Page.javascriptDialogClosed") {
          const owner = this.sessions.get(scopeKey(scope));
          const target =
            owner && [...owner.targets].find(([, attached]) => attached === sessionId)?.[0];
          if (!owner || !target || !sessionId) return;
          if (method === "Page.javascriptDialogClosed") owner.dialogs.delete(target);
          else if (["alert", "confirm", "prompt", "beforeunload"].includes(String(params.type)))
            owner.dialogs.set(target, {
              id: randomUUID(),
              type: params.type as HostBrowserDialog["type"],
              message: String(params.message ?? "").slice(0, 4000),
              ...(params.type === "prompt"
                ? { defaultPrompt: String(params.defaultPrompt ?? "").slice(0, 4000) }
                : {}),
            });
          return;
        }
        const guid =
          typeof params.guid === "string" && /^[a-zA-Z0-9-]+$/.test(params.guid) ? params.guid : "";
        if (!guid) return;
        if (method === "Browser.downloadWillBegin") {
          let allowed = downloads.size < 3;
          try {
            hostBrowserUrl(String(params.url));
          } catch {
            allowed = false;
          }
          if (allowed) downloads.set(guid, String(params.suggestedFilename ?? "download"));
          else void connection.call("Browser.cancelDownload", { guid }).catch(() => undefined);
        } else if (method === "Browser.downloadProgress") {
          if (
            Number(params.receivedBytes) > 8 * 1024 * 1024 ||
            Number(params.totalBytes) > 8 * 1024 * 1024
          ) {
            downloads.delete(guid);
            void connection.call("Browser.cancelDownload", { guid }).catch(() => undefined);
          }
          if (params.state === "completed" || params.state === "canceled") {
            const name = downloads.get(guid);
            downloads.delete(guid);
            if (params.state === "completed" && name && directory && downloadStaging) {
              const task = this.finishDownload(scope, directory, downloadStaging, guid, name);
              downloadTasks.add(task);
              void task.catch(() => undefined).finally(() => downloadTasks.delete(task));
            }
          }
        }
      });
      browser = {
        computerId: scope.computerId,
        connection,
        profile,
        unsubscribe,
        downloadStaging,
        downloadTasks,
      };
      this.browsers.set(profileKey, browser);
    }
    const session: BotSession = {
      browserKey: profileKey,
      computerId: scope.computerId,
      botId: scope.botId,
      targets: new Map(),
      active: "",
      staging: [],
      buttons: new Map(),
      dialogs: new Map(),
      images: new Map(),
    };
    this.sessions.set(key, session);
    try {
      await this.newTab(session, "about:blank");
    } catch (error) {
      await this.removeSession(key, session);
      throw error;
    }
    return session;
  }

  private connection(session: BotSession) {
    const browser = this.browsers.get(session.browserKey);
    if (!browser) throw new Error("Managed browser is closed");
    return browser.connection;
  }

  private async newTab(session: BotSession, url: string) {
    const result = await this.connection(session).call<{ targetId: string }>(
      "Target.createTarget",
      { url: hostBrowserUrl(url) },
    );
    session.targets.set(result.targetId, undefined);
    session.active = result.targetId;
  }

  private async ownedTargets(session: BotSession): Promise<TargetInfo[]> {
    const { targetInfos } = await this.connection(session).call<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    // Adopt only popups opened by this bot's own tabs, including popup descendants.
    for (let i = 0; i < targetInfos.length; i++) {
      let added = false;
      for (const target of targetInfos) {
        if (
          target.type === "page" &&
          target.openerId &&
          session.targets.has(target.openerId) &&
          !session.targets.has(target.targetId)
        ) {
          session.targets.set(target.targetId, undefined);
          session.active = target.targetId;
          added = true;
        }
      }
      if (!added) break;
    }
    const targets = targetInfos.filter(
      (target) => target.type === "page" && session.targets.has(target.targetId),
    );
    for (const targetId of session.targets.keys()) {
      if (!targets.some((target) => target.targetId === targetId)) {
        session.targets.delete(targetId);
        session.dialogs.delete(targetId);
      }
    }
    if (!session.targets.has(session.active)) session.active = targets[0]?.targetId ?? "";
    if (!session.active) {
      await this.newTab(session, "about:blank");
      return this.ownedTargets(session);
    }
    return targets;
  }

  private async page(session: BotSession, signal?: AbortSignal): Promise<Page> {
    signal?.throwIfAborted();
    const connection = this.connection(session);
    let sessionId = session.targets.get(session.active);
    if (!sessionId) {
      const attached = await connection.call<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: session.active, flatten: true },
        undefined,
        signal,
      );
      sessionId = attached.sessionId;
      session.targets.set(session.active, sessionId);
      await connection.call("Page.enable", {}, sessionId, signal);
      await connection.call(
        "Emulation.setDeviceMetricsOverride",
        { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
        sessionId,
        signal,
      );
      await connection.call(
        "Page.setInterceptFileChooserDialog",
        { enabled: true },
        sessionId,
        signal,
      );
      await connection.call("Network.enable", {}, sessionId, signal);
      await connection.call(
        "Network.setBlockedURLs",
        { urls: ["file://*", "chrome://*", "chrome-extension://*"] },
        sessionId,
        signal,
      );
    }
    return { connection, sessionId };
  }

  private async world(page: Page, signal?: AbortSignal): Promise<number> {
    const tree = await this.dispatch<{ frameTree: { frame: { id: string } } }>(
      page,
      "Page.getFrameTree",
      {},
      signal,
    );
    if (!tree) throw new BrowserDialogPending("Respond to the open browser dialog first");
    const result = await this.dispatch<{ executionContextId: number }>(
      page,
      "Page.createIsolatedWorld",
      {
        frameId: tree.frameTree.frame.id,
        worldName: "rakazo-host-browser",
      },
      signal,
    );
    if (!result) throw new BrowserDialogPending("Respond to the open browser dialog first");
    await this.evaluate(page, result.executionContextId, HOST_BROWSER_PAGE_HELPERS, signal);
    return result.executionContextId;
  }

  private async evaluate<T>(
    page: Page,
    contextId: number,
    expression: string,
    signal?: AbortSignal,
    returnByValue = true,
  ): Promise<T> {
    if (this.dialogForPage(page))
      throw new BrowserDialogPending("Respond to the open browser dialog first");
    let opened: (error: Error) => void = () => undefined;
    const dialog = new Promise<never>((_resolve, reject) => {
      opened = reject;
    });
    const unsubscribe = page.connection.onEvent?.((method, _params, sessionId) => {
      if (method === "Page.javascriptDialogOpening" && sessionId === page.sessionId)
        opened(new BrowserDialogPending("Respond to the open browser dialog first"));
    });
    const sent = page.connection.call<RemoteResult>(
      "Runtime.evaluate",
      { contextId, expression, returnByValue, awaitPromise: true },
      page.sessionId,
      signal,
    );
    void sent.catch(() => undefined);
    let result: RemoteResult;
    try {
      result = await (unsubscribe ? Promise.race([sent, dialog]) : sent);
    } finally {
      unsubscribe?.();
    }
    if (result.exceptionDetails) {
      // Deliberately omit exception text: scripts can throw saved login values.
      throw new Error(
        "The page changed or refused this browser action. Take a fresh snapshot and try again.",
      );
    }
    return (returnByValue ? result.result.value : result.result.objectId) as T;
  }

  private async snapshot(session: BotSession, signal?: AbortSignal): Promise<PageBrowserResult> {
    const targets = await this.ownedTargets(session);
    const controls = this.browserControls(session, targets);
    const target = targets.find((target) => target.targetId === session.active);
    const dialog = session.dialogs.get(session.active);
    if (dialog) {
      return {
        ok: true,
        url: target?.url ?? "",
        title: target?.title ?? "",
        elements: controls,
        tree: `${dialog.type} dialog: ${JSON.stringify(dialog.message)}${dialog.type === "prompt" ? `\nPrompt: ${JSON.stringify(dialog.promptText ?? dialog.defaultPrompt ?? "")}` : ""}\n${this.controlsTree(controls)}`,
      };
    }
    try {
      const page = await this.page(session, signal);
      const world = await this.world(page, signal);
      const snapshot = await this.evaluate<PageBrowserResult>(
        page,
        world,
        "globalThis.__rakazoHostBrowser.snapshot()",
        signal,
      );
      return {
        ...snapshot,
        elements: [...(snapshot.elements ?? []), ...controls],
        tree: `${snapshot.tree ?? ""}\n${this.controlsTree(controls)}`,
        ok: true,
      };
    } catch (error) {
      if (session.dialogs.has(session.active)) return this.snapshot(session, signal);
      throw error;
    }
  }

  private browserControls(session: BotSession, targets: TargetInfo[]): BrowserSnapshotNode[] {
    const controls: BrowserSnapshotNode[] = targets.flatMap((target) => [
      {
        ref: `rakazo-tab:${target.targetId}`,
        role: "tab",
        name: target.title || target.url || "Tab",
        value: target.targetId === session.active ? "active" : undefined,
      },
      {
        ref: `rakazo-tab-close:${target.targetId}`,
        role: "button",
        name: `Close tab ${target.title || target.url || "Tab"}`,
      },
    ]);
    controls.push(
      ...[
        ["rakazo-tab-new", "New tab"],
        ["rakazo-back", "Back"],
        ["rakazo-forward", "Forward"],
        ["rakazo-reload", "Reload"],
      ].map(([ref, name]) => ({ ref: ref!, name: name!, role: "button" })),
    );
    const dialog = session.dialogs.get(session.active);
    if (dialog) {
      controls.push({
        ref: `rakazo-dialog-accept:${dialog.id}`,
        role: "button",
        name: "Accept dialog",
      });
      if (dialog.type !== "alert")
        controls.push({
          ref: `rakazo-dialog-dismiss:${dialog.id}`,
          role: "button",
          name: "Dismiss dialog",
        });
      if (dialog.type === "prompt")
        controls.push({
          ref: `rakazo-dialog-text:${dialog.id}`,
          role: "textbox",
          name: "Dialog response",
          value: dialog.promptText ?? dialog.defaultPrompt ?? "",
        });
    }
    return controls;
  }

  private controlsTree(controls: BrowserSnapshotNode[]) {
    return controls
      .map(
        (control) =>
          `- ${control.role} ${JSON.stringify(control.name)} [${control.ref}]${control.value === undefined ? "" : ` value=${JSON.stringify(control.value)}`}`,
      )
      .join("\n");
  }

  private async handleDialog(
    session: BotSession,
    accept: boolean,
    text?: string,
    signal?: AbortSignal,
  ) {
    const dialog = session.dialogs.get(session.active);
    if (!dialog) throw new BrowserRefusal("No browser dialog is open");
    const page = await this.page(session, signal);
    await page.connection.call(
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(dialog.type === "prompt"
          ? { promptText: text ?? dialog.promptText ?? dialog.defaultPrompt ?? "" }
          : {}),
      },
      page.sessionId,
      signal,
    );
    if (session.dialogs.get(session.active)?.id === dialog.id)
      session.dialogs.delete(session.active);
    await this.settle(page, signal);
  }

  private async browserControl(
    session: BotSession,
    action: BrowserActStep,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!action.ref?.startsWith("rakazo-")) return false;
    const activeDialog = session.dialogs.get(session.active);
    if (
      action.ref.startsWith("rakazo-dialog-") &&
      (!activeDialog || !action.ref.endsWith(`:${activeDialog.id}`))
    )
      throw new BrowserRefusal("The browser dialog changed. Take a fresh snapshot");
    if (
      action.ref === `rakazo-dialog-text:${activeDialog?.id}` &&
      (action.kind === "fill" || action.kind === "type") &&
      !action.origin
    ) {
      const dialog = session.dialogs.get(session.active);
      if (dialog?.type !== "prompt") throw new BrowserRefusal("No browser prompt is open");
      dialog.promptText = action.text;
      return true;
    }
    if (action.kind !== "click") throw new BrowserRefusal("This browser control requires a click");
    if (
      action.ref === `rakazo-dialog-accept:${activeDialog?.id}` ||
      action.ref === `rakazo-dialog-dismiss:${activeDialog?.id}`
    ) {
      await this.handleDialog(
        session,
        action.ref === `rakazo-dialog-accept:${activeDialog?.id}`,
        undefined,
        signal,
      );
      return true;
    }
    const prefix = action.ref.startsWith("rakazo-tab-close:")
      ? "rakazo-tab-close:"
      : action.ref.startsWith("rakazo-tab:")
        ? "rakazo-tab:"
        : undefined;
    if (prefix) {
      const targetId = action.ref.slice(prefix.length);
      await this.ownedTargets(session);
      if (!session.targets.has(targetId))
        throw new BrowserRefusal("Browser tab does not belong to this bot");
      if (prefix === "rakazo-tab:") session.active = targetId;
      else {
        await this.connection(session).call("Target.closeTarget", { targetId }, undefined, signal);
        session.targets.delete(targetId);
        session.dialogs.delete(targetId);
        await this.ownedTargets(session);
      }
      return true;
    }
    if (action.ref === "rakazo-tab-new") {
      await this.newTab(session, "about:blank");
      return true;
    }
    const navigation = {
      "rakazo-back": "back",
      "rakazo-forward": "forward",
      "rakazo-reload": "reload",
    } as const;
    const direction = navigation[action.ref as keyof typeof navigation];
    if (direction) {
      await this.history(session, direction, signal);
      return true;
    }
    throw new BrowserRefusal("Unknown browser control. Take a fresh snapshot");
  }

  private async history(
    session: BotSession,
    direction: "back" | "forward" | "reload",
    signal?: AbortSignal,
  ) {
    if (session.dialogs.has(session.active))
      throw new BrowserRefusal("Respond to the open browser dialog first");
    const page = await this.page(session, signal);
    if (direction === "reload") await this.dispatch(page, "Page.reload", {}, signal);
    else {
      const history = await page.connection.call<{
        currentIndex: number;
        entries: { id: number }[];
      }>("Page.getNavigationHistory", {}, page.sessionId, signal);
      const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
      if (entry)
        await this.dispatch(page, "Page.navigateToHistoryEntry", { entryId: entry.id }, signal);
    }
    await this.settle(page, signal);
  }

  private dialogForPage(page: Page) {
    for (const session of this.sessions.values()) {
      if (this.browsers.get(session.browserKey)?.connection !== page.connection) continue;
      const target = [...session.targets].find(([, attached]) => attached === page.sessionId)?.[0];
      if (target && session.dialogs.has(target)) return session.dialogs.get(target);
    }
  }

  private async dispatch<T = Record<string, unknown>>(
    page: Page,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.dialogForPage(page)) return;
    let opened: () => void = () => undefined;
    const dialog = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const unsubscribe = page.connection.onEvent?.((event, _params, sessionId) => {
      if (event === "Page.javascriptDialogOpening" && sessionId === page.sessionId) opened();
    });
    const sent = page.connection.call<T>(method, params, page.sessionId, signal);
    void sent.catch(() => undefined);
    try {
      if (unsubscribe) return await Promise.race([sent, dialog]);
      return await sent;
    } finally {
      unsubscribe?.();
    }
  }

  async pageBrowser(
    scope: HostBrowserScope,
    command: PageBrowserCommand,
    signal?: AbortSignal,
  ): Promise<PageBrowserResult> {
    return this.serial(scope, async () => {
      signal?.throwIfAborted();
      const session = await this.session(scope);
      if (command.command === "navigate") {
        const page = await this.page(session, signal);
        await this.navigate(page, command.url, signal);
        return this.snapshot(session, signal);
      }
      if (command.command === "snapshot") return this.snapshot(session, signal);
      let completed = 0;
      for (const action of command.actions) {
        signal?.throwIfAborted();
        let dispatched = false;
        try {
          if (action.ref?.startsWith("rakazo-")) dispatched = true;
          if (await this.browserControl(session, action, signal)) {
            completed++;
            continue;
          }
          if (session.dialogs.has(session.active))
            throw new BrowserRefusal("Respond to the open browser dialog first");
          const page = await this.page(session, signal);
          const world = await this.world(page, signal);
          if (action.kind === "upload") {
            const files = await this.stageUploads(session, scope, action);
            const objectId = await this.evaluate<string>(
              page,
              world,
              `globalThis.__rakazoHostBrowser.fileInput(${JSON.stringify(action.ref)},${files.length})`,
              signal,
              false,
            );
            if (!objectId) throw new Error("Upload target is unavailable");
            try {
              dispatched = true;
              await this.dispatch(page, "DOM.setFileInputFiles", { files, objectId }, signal);
            } finally {
              await page.connection
                .call("Runtime.releaseObject", { objectId }, page.sessionId)
                .catch(() => undefined);
            }
          } else if (action.kind === "click") {
            const point = await this.evaluate<{
              ok: boolean;
              x: number;
              y: number;
              error?: string;
            }>(
              page,
              world,
              `globalThis.__rakazoHostBrowser.clickPoint(${JSON.stringify(action.ref)})`,
              signal,
            );
            if (!point.ok) throw new BrowserRefusal(point.error ?? "The page refused this click");
            dispatched = true;
            await this.dispatch(
              page,
              "Input.dispatchMouseEvent",
              {
                type: "mousePressed",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 1,
                clickCount: 1,
              },
              signal,
            );
            await this.dispatch(
              page,
              "Input.dispatchMouseEvent",
              {
                type: "mouseReleased",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 0,
                clickCount: 1,
              },
              signal,
            );
          } else if (action.kind === "type" && !action.origin) {
            dispatched = true;
            const preparation = await this.evaluate<{ select?: boolean }>(
              page,
              world,
              `globalThis.__rakazoHostBrowser.prepareKeys(${JSON.stringify(action.ref)},${JSON.stringify(action.text)})`,
              signal,
            );
            if (preparation.select) {
              const result = await this.evaluate<{ ok: boolean; error?: string }>(
                page,
                world,
                `globalThis.__rakazoHostBrowser.act(${JSON.stringify(action)})`,
                signal,
              );
              if (!result.ok)
                throw new BrowserRefusal(result.error ?? "The page refused this action");
            } else {
              for (const character of action.text) {
                if (session.dialogs.has(session.active))
                  throw new Error("Typing opened a browser dialog before it completed");
                if (
                  !(await this.evaluate<boolean>(
                    page,
                    world,
                    "globalThis.__rakazoHostBrowser.focusHolds()",
                    signal,
                  ))
                )
                  throw new Error("The page moved focus before typing completed");
                if (character.length > 1) {
                  await this.dispatch(page, "Input.insertText", { text: character }, signal);
                  continue;
                }
                const event = browserKeyEvent(character === "\n" ? "ENTER" : character);
                await this.dispatch(
                  page,
                  "Input.dispatchKeyEvent",
                  { ...event, type: "keyDown" },
                  signal,
                );
                await this.dispatch(
                  page,
                  "Input.dispatchKeyEvent",
                  { ...event, type: "keyUp", text: undefined },
                  signal,
                );
              }
              if (
                !(await this.evaluate<boolean>(
                  page,
                  world,
                  "globalThis.__rakazoHostBrowser.typed()",
                  signal,
                ))
              )
                throw new Error("The field did not accept all typed characters");
            }
          } else {
            dispatched = true;
            const result = await this.evaluate<{
              ok: boolean;
              uncertain?: boolean;
              error?: string;
            }>(
              page,
              world,
              `globalThis.__rakazoHostBrowser.act(${JSON.stringify(action)})`,
              signal,
            );
            if (!result.ok) {
              if (result.uncertain === false)
                throw new BrowserRefusal(result.error ?? "The page refused this action");
              throw new Error("The page interrupted this browser action");
            }
          }
          completed++;
          await this.settle(page, signal);
        } catch (error) {
          signal?.throwIfAborted();
          const snapshot = await this.snapshot(session, signal).catch(() => ({
            ok: false,
            url: "",
            title: "",
          }));
          return {
            ...snapshot,
            ok: false,
            completed,
            uncertain: error instanceof BrowserRefusal ? false : dispatched,
            ...(error instanceof BrowserRefusal ? {} : { fallback: "computer_act" as const }),
            error: error instanceof Error ? error.message : "Browser action failed",
          };
        }
      }
      return { ...(await this.snapshot(session, signal)), completed, ok: true };
    });
  }

  private async navigate(page: Page, value: string, signal?: AbortSignal) {
    const result = await this.dispatch<{ errorText?: string }>(
      page,
      "Page.navigate",
      { url: hostBrowserUrl(value) },
      signal,
    );
    if (result?.errorText) throw new Error("The browser could not load this page");
    await this.settle(page, signal);
  }

  private async settle(page: Page, signal?: AbortSignal) {
    // Bounded readiness waits: long-polling applications must remain usable.
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      if (this.dialogForPage(page)) return;
      try {
        const world = await this.world(page, signal);
        if (await this.evaluate<boolean>(page, world, "document.readyState === 'complete'", signal))
          return;
      } catch {
        signal?.throwIfAborted(); /* A new document may be replacing the old world. */
      }
      await delay(100, undefined, { signal });
    }
  }

  private async image(
    session: BotSession,
    signal?: AbortSignal,
    includeDialog = true,
  ): Promise<HostBrowserImage> {
    const dialog = session.dialogs.get(session.active);
    if (dialog) {
      let cached = session.images.get(session.active);
      if (!cached)
        cached = {
          data: (
            await sharp({
              create: { width: WIDTH, height: HEIGHT, channels: 3, background: "white" },
            })
              .jpeg()
              .toBuffer()
          ).toString("base64"),
          mimeType: "image/jpeg",
          width: WIDTH,
          height: HEIGHT,
        };
      if (!includeDialog) return cached;
      // Chromium cannot capture a paused renderer. Model screenshots show the
      // same owned dialog state the preview renders above its last browser frame.
      const escapeXml = (value: string) =>
        value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      const lines = [
        `${dialog.type} dialog`,
        ...(dialog.message.match(/.{1,65}/gu) ?? []),
        ...(dialog.type === "prompt"
          ? [`Prompt: ${dialog.promptText ?? dialog.defaultPrompt ?? ""}`]
          : []),
      ].slice(0, 12);
      const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect x="200" y="150" width="880" height="500" fill="white" stroke="black"/><text x="230" y="190" font-family="sans-serif" font-size="20" fill="black">${lines.map((line, index) => `<tspan x="230" y="${190 + index * 30}">${escapeXml(line)}</tspan>`).join("")}</text></svg>`;
      const image = await sharp(Buffer.from(cached.data, "base64"))
        .composite([{ input: Buffer.from(svg) }])
        .jpeg()
        .toBuffer();
      return { ...cached, data: image.toString("base64") };
    }
    const page = await this.page(session, signal);
    const image = await page.connection.call<{ data: string }>(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 75, captureBeyondViewport: false },
      page.sessionId,
      signal,
    );
    const captured: HostBrowserImage = {
      data: image.data,
      mimeType: "image/jpeg",
      width: WIDTH,
      height: HEIGHT,
    };
    session.images.set(session.active, captured);
    return captured;
  }

  async screenshot(scope: HostBrowserScope, signal?: AbortSignal): Promise<HostBrowserImage> {
    return this.serial(scope, async () => {
      signal?.throwIfAborted();
      const session = await this.session(scope);
      await this.ownedTargets(session);
      return this.image(session, signal);
    });
  }

  async preview(
    scope: HostBrowserScope,
    command: HostBrowserPreviewCommand,
    signal?: AbortSignal,
  ): Promise<HostBrowserPreview> {
    return this.serial(scope, async () => {
      signal?.throwIfAborted();
      const session = await this.session(scope);
      await this.ownedTargets(session);
      if (command.action === "newTab") await this.newTab(session, command.url ?? "about:blank");
      else if (command.action === "selectTab" || command.action === "closeTab") {
        if (!session.targets.has(command.tabId))
          throw new Error("Browser tab does not belong to this bot");
        if (command.action === "selectTab") session.active = command.tabId;
        else {
          await this.connection(session).call(
            "Target.closeTarget",
            { targetId: command.tabId },
            undefined,
            signal,
          );
          session.targets.delete(command.tabId);
          await this.ownedTargets(session);
        }
      } else if (command.action === "dialog") {
        if (session.dialogs.get(session.active)?.id !== command.dialogId)
          throw new BrowserRefusal("The browser dialog changed. Refresh its state");
        await this.handleDialog(session, command.accept, command.text, signal);
      } else if (command.action !== "state") {
        const page = await this.page(session, signal);
        if (command.action === "navigate") {
          if (session.dialogs.has(session.active))
            throw new BrowserRefusal("Respond to the open browser dialog first");
          await this.navigate(page, command.url, signal);
        } else if (command.action === "input") await this.actions(session, command.inputs, signal);
        else await this.history(session, command.action, signal);
      }
      const targets = await this.ownedTargets(session);
      return {
        tabs: targets.map((target) => ({
          id: target.targetId,
          title: target.title.slice(0, 200),
          url: target.url,
          active: target.targetId === session.active,
        })),
        image: await this.image(session, signal, false),
        ...(session.dialogs.has(session.active)
          ? { dialog: session.dialogs.get(session.active) }
          : {}),
      };
    });
  }

  async computerAct(scope: HostBrowserScope, request: ComputerActionRequest, signal?: AbortSignal) {
    return this.serial(scope, async () => {
      signal?.throwIfAborted();
      const session = await this.session(scope);
      await this.ownedTargets(session);
      const completed = await this.actions(session, request.actions, signal);
      if (request.settleMs) await delay(Math.min(request.settleMs, 2000), undefined, { signal });
      return {
        completed,
        ...(request.observe ? { image: await this.image(session, signal) } : {}),
      };
    });
  }

  private async actions(session: BotSession, actions: ComputerAction[], signal?: AbortSignal) {
    if (actions.length > 100) throw new Error("Too many browser input actions");
    let completed = 0;
    for (const action of actions) {
      signal?.throwIfAborted();
      const dialog = session.dialogs.get(session.active);
      if (dialog) {
        if (
          action.kind === "key" &&
          ["ENTER", "RETURN", "ESC", "ESCAPE"].includes(action.key.toUpperCase())
        )
          await this.handleDialog(
            session,
            ["ENTER", "RETURN"].includes(action.key.toUpperCase()),
            undefined,
            signal,
          );
        else if (action.kind === "clipboard" && dialog.type === "prompt")
          dialog.promptText = action.text;
        else throw new BrowserRefusal("Respond to the open browser dialog first");
        completed++;
        continue;
      }
      const page = await this.page(session, signal);
      const call = (method: string, params: Record<string, unknown>) =>
        this.dispatch(page, method, params, signal);
      if (action.kind === "pointer") {
        const { x, y } = action;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          y < 0 ||
          x >= WIDTH ||
          y >= HEIGHT
        )
          throw new Error("Pointer is outside the browser viewport");
        const button = action.button ?? "left";
        let buttons = session.buttons.get(session.active) ?? 0;
        const bit = button === "right" ? 2 : 1;
        const params = { x, y, button, clickCount: 1 };
        if (action.type === "move")
          await call("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
            buttons,
            button: buttons & 1 ? "left" : buttons & 2 ? "right" : "none",
          });
        else if (action.type === "click") {
          await call("Input.dispatchMouseEvent", {
            ...params,
            type: "mousePressed",
            buttons: buttons | bit,
          });
          await call("Input.dispatchMouseEvent", {
            ...params,
            type: "mouseReleased",
            buttons: buttons & ~bit,
          });
        } else {
          buttons = action.type === "down" ? buttons | bit : buttons & ~bit;
          await call("Input.dispatchMouseEvent", {
            ...params,
            buttons,
            type: action.type === "down" ? "mousePressed" : "mouseReleased",
          });
          session.buttons.set(session.active, buttons);
        }
      } else if (action.kind === "clipboard") {
        await call("Input.insertText", { text: action.text });
      } else if (action.kind === "key") {
        const event = browserKeyEvent(action.key, action.modifiers);
        await call("Input.dispatchKeyEvent", { ...event, type: "keyDown" });
        await call("Input.dispatchKeyEvent", { ...event, type: "keyUp", text: undefined });
      } else if (action.kind === "scroll") {
        await call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: action.x ?? WIDTH / 2,
          y: action.y ?? HEIGHT / 2,
          deltaX: ["left", "right"].includes(action.direction)
            ? (action.direction === "left" ? -1 : 1) *
              Math.min(Math.max(action.amount ?? 3, 1), 50) *
              100
            : 0,
          deltaY: ["up", "down"].includes(action.direction)
            ? (action.direction === "up" ? -1 : 1) *
              Math.min(Math.max(action.amount ?? 3, 1), 50) *
              100
            : 0,
        });
      } else if (action.kind === "wait") {
        await delay(Math.min(Math.max(action.ms, 0), 5000), undefined, { signal });
      } else if (action.kind === "open") {
        await this.navigate(page, action.path, signal);
      } else if (action.kind === "launch" || action.kind === "focus") {
        if (!/^(browser|chrome|chromium|google chrome)$/i.test(action.application))
          throw new Error("Only the managed browser can be launched from this screen");
        if (action.uri) await this.navigate(page, action.uri, signal);
      }
      completed++;
    }
    return completed;
  }

  private async removeSession(key: string, session: BotSession) {
    const browser = this.browsers.get(session.browserKey);
    if (!browser) {
      this.sessions.delete(key);
      return;
    }
    // Other bots sharing this profile retain their Chrome and tabs.
    if (
      [...this.sessions.values()].some(
        (other) => other !== session && other.browserKey === session.browserKey,
      )
    ) {
      await Promise.allSettled(
        [...session.targets.keys()].map((targetId) =>
          browser.connection.call("Target.closeTarget", { targetId }),
        ),
      );
    } else {
      await browser.connection.close();
      browser.unsubscribe?.();
      await Promise.allSettled([...browser.downloadTasks]);
      if (browser.downloadStaging)
        await rm(browser.downloadStaging, { recursive: true, force: true });
      this.browsers.delete(session.browserKey);
    }
    this.sessions.delete(key);
    await Promise.all(
      session.staging.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }

  async stop(scope: HostBrowserScope) {
    await this.closeBot(scope.computerId, scope.botId);
  }

  async closeBot(computerId: string, botId: string) {
    const scope = { computerId, botId };
    const key = scopeKey(scope);
    this.closingScopes.add(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    try {
      await (this.tails.get(browserKey(scope)) ?? Promise.resolve()).catch(() => undefined);
      const current = this.sessions.get(key);
      if (current) await this.removeSession(key, current);
    } finally {
      this.closingScopes.delete(key);
    }
  }

  async closeComputer(computerId: string) {
    this.closingComputers.add(computerId);
    try {
      const tails = [...this.tails.entries()]
        .filter(([key]) => JSON.parse(key)[0] === computerId)
        .map(([, tail]) => tail);
      await Promise.allSettled(tails);
      for (const session of [...this.sessions.values()]) {
        if (session.computerId === computerId) await this.closeBot(computerId, session.botId);
      }
    } finally {
      this.closingComputers.delete(computerId);
    }
  }

  async destroy(scope: HostBrowserScope) {
    await this.closeBot(scope.computerId, scope.botId);
    // Explicit destruction removes this bot's managed profile after its process stops.
    await rm(path.join(this.options.root, "managed-browser-profiles", hash(browserKey(scope))), {
      recursive: true,
      force: true,
    });
  }

  private async downloadDirectory(scope: HostBrowserScope): Promise<string | undefined> {
    if (!scope.downloadDirectory) return;
    if (!scope.workspaceRoot || !scope.uploadRoots?.length)
      throw new Error("Download directory is not authorized");
    const workspace = await realpath(scope.workspaceRoot);
    const expected = path.resolve(
      workspace,
      path.relative(path.resolve(scope.workspaceRoot), path.resolve(scope.downloadDirectory)),
    );
    if (
      !contains(workspace, expected) ||
      !scope.uploadRoots.some((root) => contains(path.resolve(workspace, root), expected))
    )
      throw new Error("Download directory is outside this bot's workspace");
    let current = workspace;
    for (const segment of path.relative(workspace, expected).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw new Error("Download directory must not contain symbolic links");
    }
    return expected;
  }

  private async finishDownload(
    scope: HostBrowserScope,
    directory: string,
    staging: string,
    guid: string,
    suggested: string,
  ) {
    const source = path.join(staging, guid);
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await input.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 8 * 1024 * 1024 ||
        (await fileHandlePath(input.fd)) !== (await realpath(source))
      )
        throw new Error("Invalid browser download");
      const bytes = await readBounded(input, info.size, 8 * 1024 * 1024);
      if ((await this.downloadDirectory(scope)) !== directory)
        throw new Error("Download destination changed");
      const name =
        suggested
          .replaceAll("\\", "/")
          .split("/")
          .pop()
          ?.replace(/[<>:"|?*]/g, "_")
          .split("")
          .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
          .join("")
          .replace(/[. ]+$/g, "")
          .slice(0, 180) || "download";
      const safeName = name === "." || name === ".." ? "download" : name;
      let output: Awaited<ReturnType<typeof openContainedWorkspaceFile>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const extension = path.extname(safeName);
        const candidate = attempt
          ? `${safeName.slice(0, safeName.length - extension.length)} (${attempt})${extension}`
          : safeName;
        try {
          output = await openContainedWorkspaceFile(
            directory,
            path.join(directory, candidate),
            0o600,
            true,
            directory,
          );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!output) throw new Error("Could not choose a unique download name");
      try {
        if (!contains(directory, await fileHandlePath(output.fd)))
          throw new Error("Download destination changed");
        await output.truncate(0);
        await output.writeFile(bytes);
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
      await rm(source, { force: true });
    }
  }

  private async privateDirectory(directory: string) {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.options.root);
    const relative = path.relative(this.options.root, directory);
    if (!contains(this.options.root, directory))
      throw new Error("Invalid managed browser directory");
    let parent = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      parent = path.join(parent, segment);
      await mkdir(parent, { mode: 0o700 }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent)
        throw new Error("Managed browser directory must not contain symbolic links");
      await chmod(parent, 0o700);
    }
  }

  private async stageUploads(
    session: BotSession,
    scope: HostBrowserScope,
    action: Extract<BrowserActStep, { kind: "upload" }>,
  ) {
    const files = await resolveHostBrowserUploads(scope, action);
    const stagingRoot = path.join(this.options.root, "managed-browser-uploads");
    await this.privateDirectory(stagingRoot);
    const directory = await mkdtemp(path.join(stagingRoot, "upload-"));
    session.staging.push(directory);
    let total = 0;
    const staged: string[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await fileHandlePath(handle.fd);
        const info = await handle.stat();
        const authorized = await resolveHostBrowserUploads(scope, { ...action, paths: [actual] });
        if (actual !== file || authorized[0] !== actual || !info.isFile() || info.nlink !== 1)
          throw new Error("Upload file changed before it could be read");
        if (info.size + total > 32 * 1024 * 1024) throw new Error("Upload files exceed 32 MB");
        const buffer = await readBounded(handle, info.size, 32 * 1024 * 1024 - total);
        total += buffer.length;
        if ((await fileHandlePath(handle.fd)) !== actual)
          throw new Error("Upload file changed while reading");
        const destinationDirectory = path.join(directory, String(index));
        await mkdir(destinationDirectory, { mode: 0o700 });
        const destination = path.join(destinationDirectory, path.basename(actual));
        await writeFile(destination, buffer, { mode: 0o600, flag: "wx" });
        staged.push(destination);
      } finally {
        await handle.close();
      }
    }
    return staged;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.tails.values()]);
    const results = await Promise.allSettled(
      [...this.sessions].map(([key, session]) => this.removeSession(key, session)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

export function browserKeyEvent(key: string, modifiers: string[] = []): Record<string, unknown> {
  const pieces = key.split("+");
  const canonical = pieces.pop() || key;
  const names = [...modifiers, ...pieces].map((value) => value.toLowerCase());
  const mask =
    (names.some((v) => ["alt", "option"].includes(v)) ? 1 : 0) |
    (names.some((v) => ["ctrl", "control"].includes(v)) ? 2 : 0) |
    (names.some((v) => ["meta", "cmd", "command"].includes(v)) ? 4 : 0) |
    (names.includes("shift") ? 8 : 0);
  const special: Record<string, [string, string, number]> = {
    ENTER: ["Enter", "Enter", 13],
    RETURN: ["Enter", "Enter", 13],
    TAB: ["Tab", "Tab", 9],
    BACKSPACE: ["Backspace", "Backspace", 8],
    ESC: ["Escape", "Escape", 27],
    ESCAPE: ["Escape", "Escape", 27],
    DELETE: ["Delete", "Delete", 46],
    ARROWLEFT: ["ArrowLeft", "ArrowLeft", 37],
    LEFT: ["ArrowLeft", "ArrowLeft", 37],
    ARROWRIGHT: ["ArrowRight", "ArrowRight", 39],
    RIGHT: ["ArrowRight", "ArrowRight", 39],
    ARROWUP: ["ArrowUp", "ArrowUp", 38],
    UP: ["ArrowUp", "ArrowUp", 38],
    ARROWDOWN: ["ArrowDown", "ArrowDown", 40],
    DOWN: ["ArrowDown", "ArrowDown", 40],
    HOME: ["Home", "Home", 36],
    END: ["End", "End", 35],
    PAGEUP: ["PageUp", "PageUp", 33],
    PAGEDOWN: ["PageDown", "PageDown", 34],
    SPACE: [" ", "Space", 32],
  };
  const found = special[canonical.toUpperCase()];
  if (found)
    return {
      key: found[0],
      code: found[1],
      windowsVirtualKeyCode: found[2],
      modifiers: mask,
      ...(found[0] === "Enter" ? { text: "\r" } : {}),
    };
  if (canonical.length !== 1) throw new Error("Unsupported browser key");
  const code = /^[a-z]$/i.test(canonical)
    ? `Key${canonical.toUpperCase()}`
    : /^[0-9]$/.test(canonical)
      ? `Digit${canonical}`
      : "";
  return {
    key: canonical,
    code,
    windowsVirtualKeyCode: canonical.toUpperCase().charCodeAt(0),
    modifiers: mask,
    ...(!(mask & 7) ? { text: canonical } : {}),
  };
}
