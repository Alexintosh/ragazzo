import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  addScreenProxyCapability,
  openScreenCapability,
} from "@rakazo/core/node/screen-capability";
import type { Plugin, ViteDevServer } from "vite";
import { createServer, preview } from "vite";
import type {
  HostBrowserManager,
  HostBrowserPreviewCommand,
} from "../../../packages/adapters/src/host-browser";
import { HostComputerSandbox } from "../../../packages/adapters/src/host-computer-sandbox";
import { startHostComputerServer } from "../../../packages/adapters/src/host-computer-server";

const secret = "fake-host-browser-preview-proxy-secret";
const hostToken = "ab".repeat(32);
const headers = { authorization: `Bearer ${hostToken}` };
const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: "lease",
};

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

for (const mode of ["development", "preview"] as const) {
  test.describe(`host browser viewer in ${mode}`, () => {
    let origin: string;
    let viewUrl: string;
    let controlUrl: string;
    let hostViewUrl: string;
    let stop: () => Promise<void>;
    let allowed = true;
    let commands: Record<string, unknown>[] = [];
    let frameRequests = 0;
    type PageDialog = {
      id: string;
      type: "alert" | "confirm" | "prompt";
      message: string;
      defaultPrompt?: string;
    };
    let pageDialog: PageDialog | undefined;
    let nextDialog: PageDialog | undefined;
    let tabs = [
      { id: "first", title: "Browser workspace", url: "https://example.test/", active: true },
    ];

    test.beforeAll(async ({ browser }) => {
      const source = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await source.setContent(
        '<body style="font:20px system-ui;padding:48px"><h1>Browser workspace</h1><p>Managed browser preview</p><input placeholder="Message"><button>Continue</button></body>',
      );
      const image = {
        data: (await source.screenshot()).toString("base64"),
        mimeType: "image/png",
        width: 1280,
        height: 800,
      };
      await source.close();
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-host-browser-preview-"));
      await mkdir(path.join(root, "dist"));
      const browserManager = {
        preview: async (_scope: unknown, command: HostBrowserPreviewCommand) => {
          if (command.action === "state") frameRequests++;
          else commands.push(command);
          if (command.action === "navigate") tabs[0]!.url = command.url;
          if (command.action === "newTab")
            tabs = [
              ...tabs.map((tab) => ({ ...tab, active: false })),
              { id: "second", title: "New tab", url: "about:blank", active: true },
            ];
          if (command.action === "selectTab")
            tabs = tabs.map((tab) => ({ ...tab, active: tab.id === command.tabId }));
          if (command.action === "dialog") {
            pageDialog = nextDialog;
            nextDialog = undefined;
          }
          return { image, tabs, ...(pageDialog ? { dialog: pageDialog } : {}) };
        },
        stop: async () => {},
        close: async () => {},
      } as unknown as HostBrowserManager;
      const upstream = await startHostComputerServer({
        root,
        token: hostToken,
        hostname: "127.0.0.1",
        writeScopeRoot: path.join(root, "write-scopes"),
        browserManager,
      });
      upstream.setEnabled(true);
      const host = `http://127.0.0.1:${upstream.port}`;
      const client = new HostComputerSandbox(host, hostToken);
      const context = {
        operationId: "preview-test",
        traceId: "preview-test",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        signal: new AbortController().signal,
      };
      const computer = await client.provision({ botId: "team-home", homePath: "/unused" }, context);
      computer.scope = "team";
      const viewSession = await client.connectScreen(
        computer,
        { view: "stream", interactive: false },
        context,
      );
      hostViewUrl = viewSession.url!;
      await client.setScreenControl(computer, true, context, "lease");
      const controlSession = await client.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "lease" },
        context,
      );
      const authority = createHttpServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const capability = openScreenCapability(body.path, secret);
        if (!allowed || !capability || req.headers.authorization !== `Bearer ${secret}`) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(capability.target));
      });
      const fixture: Plugin = {
        name: "host-browser-app-fixture",
        configureServer: installApp,
        configurePreviewServer: installApp,
      };
      function installApp(server: Pick<ViteDevServer, "middlewares">) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/app") return next();
          res.setHeader("content-type", "text/html");
          res.end("<!doctype html><title>Application</title><body></body>");
        });
      }
      const previousApi = process.env.API_PROXY_TARGET;
      const previousSecret = process.env.SCREEN_PROXY_SECRET;
      process.env.API_PROXY_TARGET = await listen(authority);
      process.env.SCREEN_PROXY_SECRET = secret;
      try {
        const config = {
          root,
          configFile: path.resolve(import.meta.dirname, "../vite.config.ts"),
          mode: "test",
          plugins: [fixture],
          logLevel: "silent" as const,
          server: { host: "127.0.0.1", port: 0, hmr: false as const },
          preview: { host: "127.0.0.1", port: 0 },
        };
        const server = mode === "development" ? await createServer(config) : await preview(config);
        if ("listen" in server) await listen(server.httpServer!);
        origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
        viewUrl = addScreenProxyCapability(
          `${viewSession.url}?view_only=true`,
          secret,
          origin,
          scope,
          undefined,
          headers,
        );
        controlUrl = addScreenProxyCapability(
          `${controlSession.url}?view_only=false`,
          secret,
          origin,
          scope,
          undefined,
          headers,
        );
        stop = async () => {
          await server.close();
          await upstream.close();
          await close(authority);
          await rm(root, { recursive: true, force: true });
        };
      } finally {
        if (previousApi === undefined) delete process.env.API_PROXY_TARGET;
        else process.env.API_PROXY_TARGET = previousApi;
        if (previousSecret === undefined) delete process.env.SCREEN_PROXY_SECRET;
        else process.env.SCREEN_PROXY_SECRET = previousSecret;
      }
    });
    test.afterAll(async () => {
      await stop?.();
    });
    test.beforeEach(() => {
      allowed = true;
      commands = [];
      frameRequests = 0;
      pageDialog = undefined;
      nextDialog = undefined;
      tabs = [
        { id: "first", title: "Browser workspace", url: "https://example.test/", active: true },
      ];
    });

    test("live read-only preview keeps host credentials scoped and disables input", async ({
      page,
      request,
    }) => {
      await page.goto(`${origin}/app`);
      await page
        .context()
        .addCookies([{ name: "app-session", value: "fake-session", url: origin }]);
      await page.evaluate((url) => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts", "allow-pointer-lock");
        iframe.src = url;
        iframe.style.cssText = "width:100%;height:700px;border:0";
        document.body.append(iframe);
      }, viewUrl);
      const viewer = page.frameLocator("iframe");
      await expect(viewer.locator("html")).toHaveClass("noVNC_connected");
      await expect.poll(() => frameRequests).toBeGreaterThan(1);
      await expect(viewer.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
      await expect(viewer.getByRole("textbox", { name: "Address" })).toHaveAttribute(
        "readonly",
        "",
      );
      expect(
        (
          await request.post(viewUrl.replace("embed.html", "input"), { data: { action: "newTab" } })
        ).status(),
      ).toBe(403);
      expect(
        (
          await request.post(
            viewUrl.replace(/\/browser-screen\/[a-f0-9]{64}\/embed\.html/, "/computer"),
            {
              data: {},
            },
          )
        ).status(),
      ).toBe(403);
      expect(commands).toEqual([]);
      expect(
        (await request.get(hostViewUrl, { headers: { ...headers, origin: "null" } })).status(),
      ).toBe(401);
      expect(await viewer.locator("body").innerHTML()).not.toContain(hostToken);
      pageDialog = { id: "readonly", type: "confirm", message: "Confirm action" };
      const readonlyDialog = viewer.getByRole("dialog", { name: "Page dialog" });
      await expect(readonlyDialog).toBeVisible();
      await expect(readonlyDialog.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
      await expect(
        readonlyDialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeDisabled();
      expect(commands).toEqual([]);
    });

    test("renders page dialogs safely and sends prompt, accept and dismiss responses", async ({
      page,
    }) => {
      await page.goto(`${origin}/app`);
      await page.evaluate((url) => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts", "allow-pointer-lock");
        iframe.src = url;
        iframe.style.cssText = "width:100%;height:700px;border:0";
        document.body.append(iframe);
      }, controlUrl);
      const viewer = page.frameLocator("iframe");
      await expect(viewer.locator("html")).toHaveClass("noVNC_connected");
      const dialog = viewer.getByRole("dialog", { name: "Page dialog" });
      pageDialog = {
        id: "prompt",
        type: "prompt",
        message: '<img src=x onerror="window.injected=true">',
        defaultPrompt: "Initial",
      };
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(pageDialog.message);
      await expect(dialog.locator("img")).toHaveCount(0);
      const response = dialog.getByRole("textbox", { name: "Response" });
      await expect(response).toHaveValue("Initial");
      await response.fill("Updated response");
      const beforePoll = frameRequests;
      await expect.poll(() => frameRequests).toBeGreaterThan(beforePoll);
      await expect(response).toHaveValue("Updated response");
      await response.press("Enter");
      await expect(dialog).not.toBeVisible();
      expect(commands).toContainEqual({
        action: "dialog",
        dialogId: "prompt",
        accept: true,
        text: "Updated response",
      });
      pageDialog = { id: "confirm", type: "confirm", message: "Continue?" };
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "OK", exact: true }).press("Escape");
      await expect(dialog).not.toBeVisible();
      expect(commands).toContainEqual({ action: "dialog", dialogId: "confirm", accept: false });
      pageDialog = { id: "alert", type: "alert", message: "Completed" };
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox")).not.toBeVisible();
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(commands).toContainEqual({ action: "dialog", dialogId: "alert", accept: true });
      pageDialog = { id: "repeat-first", type: "confirm", message: "Again?" };
      nextDialog = { ...pageDialog, id: "repeat-second" };
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await expect
        .poll(() =>
          commands.some(
            (command) => command.action === "dialog" && command.dialogId === "repeat-first",
          ),
        )
        .toBe(true);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(commands).toContainEqual({
        action: "dialog",
        dialogId: "repeat-second",
        accept: false,
      });
    });

    test("takeover supports tabs, navigation, scaled pointer, typing and native mobile keys, then revokes", async ({
      page,
    }, testInfo) => {
      await page.goto(`${origin}/app`);
      await page.evaluate((url) => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts", "allow-pointer-lock");
        iframe.src = url;
        iframe.style.cssText = "width:100%;height:700px;border:0";
        document.body.append(iframe);
      }, controlUrl);
      const viewer = page.frameLocator("iframe");
      await expect(viewer.locator("html")).toHaveClass("noVNC_connected");
      await viewer.getByRole("textbox", { name: "Address" }).fill("https://example.test/next");
      await viewer.getByRole("textbox", { name: "Address" }).press("Enter");
      await expect
        .poll(() =>
          commands.some((c) => c.action === "navigate" && c.url === "https://example.test/next"),
        )
        .toBe(true);
      const screen = viewer.locator("canvas");
      await screen.click({ position: { x: 200, y: 150 } });
      await page.keyboard.type("hello");
      await page.keyboard.press("Control+A");
      await page.mouse.wheel(0, 300);
      await screen.evaluate((element) => {
        const bridge = (
          element.ownerDocument.defaultView as unknown as {
            rakazoComputerKeyboard: { run(command: unknown): void };
          }
        ).rakazoComputerKeyboard;
        bridge.run({ type: "text", text: "Mobile input" });
        bridge.run({ type: "backspace", count: 70 });
      });
      await expect
        .poll(() => commands.filter((c) => c.action === "input").length)
        .toBeGreaterThan(12);
      const inputs = commands.flatMap((command) =>
        Array.isArray(command.inputs) ? command.inputs : [],
      );
      expect(inputs).toContainEqual(expect.objectContaining({ kind: "pointer", type: "down" }));
      expect(inputs).toContainEqual({ kind: "key", key: "A", modifiers: ["Control"] });
      expect(inputs).toContainEqual({ kind: "clipboard", text: "Mobile input" });
      expect(
        inputs.filter((input) => input.kind === "key" && input.key === "Backspace"),
      ).toHaveLength(70);
      expect(inputs).toContainEqual({ kind: "scroll", direction: "down", amount: 3 });
      await viewer.getByRole("button", { name: "New tab", exact: true }).click();
      await expect(
        viewer.getByRole("navigation", { name: "Browser tabs" }).getByRole("button"),
      ).toHaveCount(2);
      await viewer.getByRole("button", { name: "Browser workspace", exact: true }).click();
      await expect
        .poll(() =>
          commands.some((command) => command.action === "selectTab" && command.tabId === "first"),
        )
        .toBe(true);
      const screenshot = testInfo.outputPath(`host-browser-${mode}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`host-browser-${mode}`, { path: screenshot, contentType: "image/png" });
      allowed = false;
      await expect(viewer.getByRole("alert")).toHaveText("Browser unavailable");
      const before = commands.length;
      await screen.click({ force: true });
      expect(commands.length).toBe(before);
      await expect(viewer.locator("html")).toHaveClass("noVNC_failed");
    });
  });
}
