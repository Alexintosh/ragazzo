import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostBrowserManager } from "./host-browser.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

const token = "ab".repeat(32);
const image = {
  data: Buffer.from("fixture-image").toString("base64"),
  mimeType: "image/jpeg" as const,
  width: 1280,
  height: 800,
};
const context: AdapterContext = {
  operationId: "browser-test",
  traceId: "browser-test",
  spaceId: "space",
  userId: "owner",
  botId: "bot-one",
  runId: "run-one",
  screenLeaseId: "run-one:1",
  signal: new AbortController().signal,
};

describe("authenticated host browser integration", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startHostComputerServer>>;
  let client: HostComputerSandbox;
  let computer: ComputerRef;
  let origin: string;
  const pageBrowser = vi.fn(async () => ({
    ok: true,
    url: "https://example.test/",
    title: "Fixture",
    tree: "- button Submit [e1]",
    elements: [{ ref: "e1", role: "button", name: "Submit" }],
  }));
  const preview = vi.fn(async () => ({
    tabs: [{ id: "tab-one", title: "Fixture", url: "https://example.test/", active: true }],
    image,
  }));
  const stop = vi.fn(async () => {});
  async function startServer() {
    server = await startHostComputerServer({
      root,
      token,
      hostname: "127.0.0.1",
      writeScopeRoot: path.join(root, "write-scopes"),
      browserManager: {
        pageBrowser,
        preview,
        stop,
        screenshot: async () => image,
        computerAct: async () => ({ completed: 1, image }),
        close: async () => {},
      } as unknown as HostBrowserManager,
    });
    server.setEnabled(true);
    origin = `http://127.0.0.1:${server.port}`;
    client = new HostComputerSandbox(origin, token);
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-host-browser-http-")));
    await startServer();
    computer = await client.provision({ botId: "private-home", homePath: "/unused" }, context);
  });
  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it.each(["stop", "restart"] as const)(
    "reports a gone screen after host %s and previews again after provisioning before navigation",
    async (action) => {
      if (action === "stop") await client.stop(computer, context);
      else {
        await server.close();
        await startServer();
      }
      expect(await client.isRunning(computer, context)).toBe(false);
      const failure = await client
        .connectScreen(computer, { view: "stream" }, context)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(isSandboxGoneError(failure)).toBe(true);
      expect(preview).not.toHaveBeenCalled();
      expect(pageBrowser).not.toHaveBeenCalled();

      computer = await client.provision({ botId: "private-home", homePath: "/unused" }, context);
      const viewer = await client.connectScreen(computer, { view: "stream" }, context);
      const frame = await fetch(new URL("frame", viewer.url!), { headers: viewer.headers });
      expect(frame.status).toBe(200);
      expect(await frame.json()).toMatchObject({ image: { width: 1280 } });
      expect(pageBrowser).not.toHaveBeenCalled();
    },
  );

  it("offers page and visual tools on the same owned browser and returns a credential-free viewer URL", async () => {
    expect(
      await client.pageBrowser(
        computer,
        { command: "navigate", url: "https://example.test/" },
        context,
      ),
    ).toMatchObject({ ok: true, title: "Fixture" });
    const observed = await client.observe(computer, context);
    expect(Buffer.from(observed.image).toString()).toBe("fixture-image");
    expect(
      await client.act(
        computer,
        { actions: [{ kind: "key", key: "Enter" }], observe: true },
        context,
      ),
    ).toMatchObject({ completed: 1, observation: { width: 1280 } });
    const viewer = await client.connectScreen(computer, { view: "stream" }, context);
    expect(viewer.url).toMatch(/\/browser-screen\/[a-f0-9]{64}\/embed.html$/);
    expect(viewer.url).not.toContain(token);
    expect(viewer.headers).toEqual({ Authorization: `Bearer ${token}` });
    const response = await fetch(viewer.url!, { headers: viewer.headers });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(token);
    const frame = await fetch(new URL("frame", viewer.url!), { headers: viewer.headers });
    expect(await frame.json()).toMatchObject({
      tabs: [{ title: "Fixture" }],
      image: { width: 1280 },
    });
  });

  it("enforces bearer, consent, Origin rejection and read-only preview at the actual HTTP server", async () => {
    const viewer = await client.connectScreen(computer, { view: "stream" }, context);
    expect((await fetch(viewer.url!)).status).toBe(401);
    expect(
      (await fetch(viewer.url!, { headers: { ...viewer.headers, Origin: "null" } })).status,
    ).toBe(401);
    const command = {
      method: "POST",
      headers: { ...viewer.headers, "content-type": "text/plain" },
      body: JSON.stringify({ action: "navigate", url: "https://example.test/" }),
    };
    expect((await fetch(new URL("input", viewer.url!), command)).status).toBe(403);
    server.setEnabled(false);
    expect((await fetch(viewer.url!, { headers: viewer.headers })).status).toBe(403);
    await expect.poll(() => stop.mock.calls.length).toBe(1);
    server.setEnabled(true);
    const replacement = await client.connectScreen(computer, { view: "stream" }, context);
    expect((await fetch(replacement.url!, { headers: replacement.headers })).status).toBe(200);
  });

  it("grants interactive preview on connection and revokes it when the control lease is released", async () => {
    const viewer = await client.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "control-one" },
      context,
    );
    const send = () =>
      fetch(new URL("input", viewer.url!), {
        method: "POST",
        headers: { ...viewer.headers, "content-type": "text/plain" },
        body: JSON.stringify({
          action: "input",
          inputs: [{ kind: "scroll", direction: "down", amount: 3 }],
        }),
      });
    expect((await send()).status).toBe(200);
    await client.setScreenControl(computer, false, context, "control-one");
    expect((await send()).status).toBe(403);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("keeps another Team bot's browser alive when stopping one run", async () => {
    await client.pageBrowser(computer, { command: "snapshot" }, context);
    const peer = { ...context, botId: "bot-two", runId: "run-two", screenLeaseId: "run-two:2" };
    await client.pageBrowser(computer, { command: "snapshot" }, peer);
    const peerViewer = await client.connectScreen(computer, { view: "stream" }, peer);
    await client.cancelRunWork(computer, computer.id, "run-one", context);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await fetch(peerViewer.url!, { headers: peerViewer.headers })).status).toBe(200);
  });

  it("closes idle registered-host scope and rejects late requests for that registration", async () => {
    const registered = { ...computer, registeredHostId: "registration-one" };
    await client.pageBrowser(registered, { command: "snapshot" }, context);
    const received = [];
    for await (const value of client.request(
      {
        method: "browserRevokeScope",
        botId: "setup",
        scope: {
          spaceId: context.spaceId,
          userId: context.userId,
          registrationId: "registration-one",
        },
      },
      context,
    ))
      received.push(value);
    expect(received).toEqual([{ browserCleanupVerified: true }]);
    await expect(
      client.pageBrowser(registered, { command: "snapshot" }, context),
    ).rejects.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
    const replacement = { ...computer, registeredHostId: "registration-two" };
    await expect(
      client.pageBrowser(replacement, { command: "snapshot" }, context),
    ).resolves.toMatchObject({ ok: true });
  });
});
