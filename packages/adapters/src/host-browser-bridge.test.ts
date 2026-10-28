import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { HostBrowserManager, HostBrowserScope } from "./host-browser.js";
import { HostBrowserBridge } from "./host-browser-bridge.js";
import type { HostBrowserIdentity, HostBrowserRequest } from "./host-browser-protocol.js";

class MemoryResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  body = "";
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  end(body?: string) {
    this.headersSent = true;
    this.body += body ?? "";
    return this;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
const computer: ComputerRef = {
  id: "computer",
  botId: "team-home",
  kind: "desktop",
  providerRef: path.resolve("/fake-host/team"),
};
const identity: HostBrowserIdentity = {
  registrationId: "registration-one",
  spaceId: "space",
  userId: "user",
  botId: "bot-a",
  mode: "team",
};
const frame = {
  tabs: [],
  image: { data: "fake-jpeg", mimeType: "image/jpeg", width: 1280, height: 800 },
};
function fixture() {
  const manager = {
    pageBrowser: vi.fn(
      async (_scope: HostBrowserScope, _command: unknown, _signal: AbortSignal) => ({ ok: true }),
    ),
    screenshot: vi.fn(async (_scope: HostBrowserScope, _signal: AbortSignal) => ({
      frameId: "frame",
    })),
    computerAct: vi.fn(
      async (_scope: HostBrowserScope, _request: unknown, _signal: AbortSignal) => ({
        completed: 1,
      }),
    ),
    preview: vi.fn(
      async (_scope: HostBrowserScope, _command: unknown, _signal: AbortSignal): Promise<unknown> =>
        frame,
    ),
    stop: vi.fn(async (_scope: HostBrowserScope): Promise<void> => undefined),
    close: vi.fn(async () => undefined),
  };
  const bridge = new HostBrowserBridge(manager as unknown as HostBrowserManager);
  const dispatch = (request: HostBrowserRequest, ref = computer) =>
    bridge.dispatch(request, ref, new AbortController().signal);
  const base = (scope = identity, home = computer.botId) => ({ botId: home, scope });
  const observe = (
    scope = identity,
    home = computer.botId,
    runId?: string,
    fence = 1,
    ref = computer,
  ) =>
    dispatch(
      {
        ...base(scope, home),
        method: "browserObserve",
        ...(runId ? { runId, screenLeaseId: `${runId}:${fence}` } : {}),
      },
      ref,
    );
  const control = (token: string, interactive = true, scope = identity, home = computer.botId) =>
    dispatch({ ...base(scope, home), method: "browserControl", interactive, controlToken: token });
  const viewer = async (
    interactive = false,
    scope = identity,
    home = computer.botId,
    token = "lease",
  ) => {
    if (interactive) await control(token, true, scope, home);
    const result = (await dispatch({
      ...base(scope, home),
      method: "browserScreen",
      interactive,
      ...(interactive ? { controlToken: token } : {}),
    })) as { path: string };
    return result.path;
  };
  const serve = (url: string, method = "GET", body?: unknown, headers?: Record<string, string>) => {
    const request = Object.assign(new PassThrough(), {
      url,
      method,
      headers: { "content-type": "text/plain", ...headers },
    });
    const response = new MemoryResponse();
    const done = bridge.serve(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    request.end(
      body === undefined
        ? undefined
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    );
    return { request, response, done };
  };
  const request = async (
    url: string,
    method = "GET",
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const result = serve(url, method, body, headers);
    await result.done;
    return result.response;
  };
  return { bridge, manager, dispatch, base, observe, control, viewer, serve, request };
}

describe("host browser ownership bridge", () => {
  it("derives Team upload and download roots from the trusted computer and acting bot", async () => {
    const { observe, manager } = fixture();
    await observe();
    expect(manager.screenshot.mock.calls[0]![0]).toMatchObject({
      botId: "bot-a",
      workspaceRoot: computer.providerRef,
      uploadRoots: [path.join("bots", "bot-a"), "shared"],
      downloadDirectory: path.join(computer.providerRef, "bots", "bot-a", "Downloads"),
    });
  });

  it("keeps a dedicated computer at its own workspace root", async () => {
    const { observe, manager } = fixture();
    const ref = {
      ...computer,
      botId: "private-home",
      providerRef: path.resolve("/fake-host/private"),
    };
    await observe({ ...identity, mode: "dedicated" }, ref.botId, undefined, 1, ref);
    expect(manager.screenshot.mock.calls[0]![0]).toMatchObject({
      workspaceRoot: ref.providerRef,
      uploadRoots: ["."],
      downloadDirectory: path.join(ref.providerRef, "Downloads"),
    });
  });

  it("separates bot profiles while retaining the same shared computer identity", async () => {
    const { observe, manager } = fixture();
    await observe();
    await observe({ ...identity, botId: "bot-b" });
    const first = manager.screenshot.mock.calls[0]![0];
    const second = manager.screenshot.mock.calls[1]![0];
    expect(first.computerId).toBe(second.computerId);
    expect(first.botId).not.toBe(second.botId);
    expect(first.downloadDirectory).not.toBe(second.downloadDirectory);
    expect(second.uploadRoots).toEqual([path.join("bots", "bot-b"), "shared"]);
  });

  it("separates identical home and bot ids across users and Spaces", async () => {
    const { observe, manager } = fixture();
    await observe();
    await observe({ ...identity, userId: "other-user" });
    await observe({ ...identity, spaceId: "other-space" });
    expect(new Set(manager.screenshot.mock.calls.map(([scope]) => scope.computerId)).size).toBe(3);
  });

  it("serves read-only frames and refuses forged manual input", async () => {
    const { viewer, request, manager } = fixture();
    const url = await viewer();
    const page = await request(url);
    expect(page.statusCode).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.body).toContain("const interactive = false");
    expect(page.body).not.toContain(computer.providerRef);
    const image = await request(url.replace("embed.html", "frame"));
    expect(image.statusCode).toBe(200);
    expect(JSON.parse(image.body)).toEqual(frame);
    manager.preview.mockClear();
    expect(
      (await request(url.replace("embed.html", "input"), "POST", { action: "newTab" })).statusCode,
    ).toBe(403);
    expect(manager.preview).not.toHaveBeenCalled();
  });

  it("requires a matching granted lease before opening an interactive viewer", async () => {
    const { dispatch, base, control } = fixture();
    await expect(
      dispatch({
        ...base(),
        method: "browserScreen",
        interactive: true,
        controlToken: "ungranted",
      }),
    ).rejects.toThrow("lease changed");
    await control("lease");
    await expect(
      dispatch({ ...base(), method: "browserScreen", interactive: true, controlToken: "other" }),
    ).rejects.toThrow("lease changed");
  });

  it("validates user input including scroll while refusing untrusted action kinds and malformed bodies", async () => {
    const { viewer, request, manager } = fixture();
    const input = (await viewer(true)).replace("embed.html", "input");
    expect(
      (
        await request(input, "POST", {
          action: "input",
          inputs: [{ kind: "scroll", direction: "down", amount: 3 }],
        })
      ).statusCode,
    ).toBe(200);
    expect(manager.preview).toHaveBeenCalledWith(
      expect.anything(),
      { action: "input", inputs: [{ kind: "scroll", direction: "down", amount: 3 }] },
      expect.any(AbortSignal),
    );
    manager.preview.mockClear();
    for (const body of [
      "{bad json",
      { action: "input", inputs: [{ kind: "open", path: "/private" }] },
      { action: "input", inputs: Array.from({ length: 33 }, () => ({ kind: "key", key: "a" })) },
    ]) {
      expect((await request(input, "POST", body)).statusCode).toBe(409);
    }
    expect(
      (
        await request(
          input,
          "POST",
          { action: "newTab" },
          { "content-type": "application/x-www-form-urlencoded" },
        )
      ).statusCode,
    ).toBe(403);
    expect((await request(input, "POST", "x".repeat(128 * 1024 + 1))).statusCode).toBe(413);
    expect(manager.preview).not.toHaveBeenCalled();
  });

  it("revokes an old interactive viewer and aborts its pending input when control changes", async () => {
    const { viewer, serve, request, control, manager } = fixture();
    const url = await viewer(true);
    const started = deferred<AbortSignal>();
    manager.preview.mockImplementationOnce(async (_scope, _command, signal) => {
      started.resolve(signal);
      return aborted(signal);
    });
    const pending = serve(url.replace("embed.html", "input"), "POST", { action: "newTab" });
    const signal = await started.promise;
    await control("replacement");
    expect(signal.aborted).toBe(true);
    await pending.done;
    expect(pending.response.statusCode).toBe(409);
    expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(403);
  });

  it("aborts pending control work when the user releases control", async () => {
    const { viewer, serve, control, manager } = fixture();
    const url = await viewer(true);
    const started = deferred<AbortSignal>();
    manager.preview.mockImplementationOnce(async (_scope, _command, signal) => {
      started.resolve(signal);
      return aborted(signal);
    });
    const pending = serve(url.replace("embed.html", "input"), "POST", { action: "reload" });
    const signal = await started.promise;
    await control("lease", false);
    expect(signal.aborted).toBe(true);
    await pending.done;
    expect(pending.response.statusCode).toBe(409);
  });

  it("refuses bot actions during manual control and admits them after release", async () => {
    const { control, observe, manager } = fixture();
    await control("lease");
    await expect(observe(identity, computer.botId, "run")).rejects.toThrow(
      "Release browser control",
    );
    expect(manager.screenshot).not.toHaveBeenCalled();
    await control("lease", false);
    await observe(identity, computer.botId, "run");
    expect(manager.screenshot).toHaveBeenCalledOnce();
  });

  it("does not let an old user-control release revoke its replacement", async () => {
    const { viewer, control, request } = fixture();
    const url = await viewer(true, identity, computer.botId, "replacement");
    await control("old-lease", false);
    expect(
      (await request(url.replace("embed.html", "input"), "POST", { action: "reload" })).statusCode,
    ).toBe(200);
  });

  it("keeps the current viewer alive when the same control lease is granted again", async () => {
    const { viewer, control, request } = fixture();
    const url = await viewer(true);
    await control("lease");
    expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(200);
  });

  it("rechecks the lease after an input body finishes streaming", async () => {
    const { bridge, viewer, control, manager } = fixture();
    const url = (await viewer(true)).replace("embed.html", "input");
    const request = Object.assign(new PassThrough(), {
      url,
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    const response = new MemoryResponse();
    const pending = bridge.serve(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    request.write('{"action":');
    await control("lease", false);
    request.end('"newTab"}');
    await pending;
    expect(response.statusCode).toBe(409);
    expect(manager.preview).not.toHaveBeenCalled();
  });

  it("aborts a pending frame when its client disconnects", async () => {
    const { viewer, serve, manager } = fixture();
    const url = await viewer();
    const started = deferred<AbortSignal>();
    manager.preview.mockImplementationOnce(async (_scope, _command, signal) => {
      started.resolve(signal);
      return aborted(signal);
    });
    const pending = serve(url.replace("embed.html", "frame"));
    const signal = await started.promise;
    pending.response.emit("close");
    await pending.done;
    expect(signal.aborted).toBe(true);
  });

  it("fences delayed run releases and stale actions after a newer run takes the screen", async () => {
    const { observe, dispatch, base, manager } = fixture();
    await observe(identity, computer.botId, "old", 1);
    await observe(identity, computer.botId, "replacement", 2);
    await dispatch({
      ...base(),
      method: "browserRelease",
      screenLeaseId: "old:1",
      keepWarm: false,
    });
    expect(manager.stop).not.toHaveBeenCalled();
    await expect(observe(identity, computer.botId, "old", 1)).rejects.toThrow("lease changed");
    await observe(identity, computer.botId, "replacement", 2);
    await dispatch({
      ...base(),
      method: "browserRelease",
      screenLeaseId: "replacement:2",
      keepWarm: false,
    });
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("aborts old bot work when a newer fenced run replaces it", async () => {
    const { dispatch, base, observe, manager } = fixture();
    const started = deferred<AbortSignal>();
    manager.pageBrowser.mockImplementationOnce(async (_scope, _command, signal) => {
      started.resolve(signal);
      return aborted(signal);
    });
    const pending = dispatch({
      ...base(),
      method: "browserPage",
      runId: "old",
      screenLeaseId: "old:1",
      command: { command: "snapshot" },
    });
    const rejected = expect(pending).rejects.toBeDefined();
    const signal = await started.promise;
    await observe(identity, computer.botId, "replacement", 2);
    expect(signal.aborted).toBe(true);
    await rejected;
  });

  it("cancels only matching runs on the requested computer home", async () => {
    const { bridge, observe, manager } = fixture();
    await observe(identity, computer.botId, "target");
    await observe({ ...identity, botId: "bot-b" }, computer.botId, "other-run");
    await observe({ ...identity, botId: "bot-c" }, "other-home", "target");
    await bridge.cancelRun(computer.botId, ["target"]);
    expect(manager.stop.mock.calls.map(([scope]) => scope.botId)).toEqual(["bot-a"]);
    await observe({ ...identity, botId: "bot-b" }, computer.botId, "other-run");
    await observe({ ...identity, botId: "bot-c" }, "other-home", "target");
    await bridge.cancelRun(computer.botId, ["missing"]);
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("keeps a failed-cleanup tombstone, refuses false cleanup proof, and retries teardown", async () => {
    const { dispatch, observe, viewer, request, manager } = fixture();
    await observe(identity, computer.botId, "run");
    const url = await viewer();
    manager.stop.mockRejectedValueOnce(new Error("Chrome cleanup failed"));
    const revoke: HostBrowserRequest = {
      method: "browserRevokeScope",
      botId: "setup",
      scope: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        registrationId: identity.registrationId!,
      },
    };
    await expect(dispatch(revoke)).rejects.toThrow("Chrome cleanup failed");
    expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(403);
    await expect(observe()).rejects.toThrow("stopping");
    await expect(dispatch(revoke)).resolves.toEqual({ browserCleanupVerified: true });
    expect(manager.stop).toHaveBeenCalledTimes(2);
    expect(manager.stop.mock.calls[0]![0]).toEqual(manager.stop.mock.calls[1]![0]);
    await expect(observe()).rejects.toThrow("stopping");
    await observe({ ...identity, registrationId: "replacement-registration" });
  });

  it("revokes only the requested user and Space while preserving other browser sessions", async () => {
    const { dispatch, viewer, request, manager } = fixture();
    const otherUser = { ...identity, userId: "other-user" };
    const otherSpace = { ...identity, spaceId: "other-space" };
    const owned = [await viewer(), await viewer(false, { ...identity, botId: "bot-b" })];
    const preserved = [await viewer(false, otherUser), await viewer(false, otherSpace)];
    await expect(
      dispatch({
        method: "browserRevokeScope",
        botId: "setup",
        scope: { spaceId: identity.spaceId, userId: identity.userId },
      }),
    ).resolves.toEqual({ browserCleanupVerified: true });
    expect(manager.stop).toHaveBeenCalledTimes(2);
    for (const url of owned)
      expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(403);
    for (const url of preserved)
      expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(200);
  });

  it("stops every browser on disable while allowing fresh sessions after re-enable", async () => {
    const { bridge, viewer, observe, request, manager } = fixture();
    const first = await viewer();
    const second = await viewer(false, { ...identity, botId: "bot-b" });
    await bridge.stopAll();
    expect(manager.stop).toHaveBeenCalledTimes(2);
    expect(manager.close).not.toHaveBeenCalled();
    for (const url of [first, second])
      expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(403);
    await observe();
    const fresh = await viewer();
    expect((await request(fresh.replace("embed.html", "frame"))).statusCode).toBe(200);
  });

  it("shares pending cleanup so concurrent stops cannot close a replacement twice", async () => {
    const { bridge, observe, manager } = fixture();
    await observe();
    const cleanup = deferred<void>();
    manager.stop.mockImplementationOnce(() => cleanup.promise);
    const first = bridge.stopComputer(computer.botId);
    const second = bridge.stopComputer(computer.botId);
    expect(manager.stop).toHaveBeenCalledOnce();
    cleanup.resolve();
    await Promise.all([first, second]);
    await observe();
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("blocks new owners while any stop for their computer is admitted", async () => {
    const { bridge, observe } = fixture();
    const first = bridge.beginComputerStop(computer.botId);
    const second = bridge.beginComputerStop(computer.botId);
    await expect(observe()).rejects.toThrow("stopping");
    first();
    first();
    await expect(observe()).rejects.toThrow("stopping");
    await observe(identity, "other-home");
    second();
    await observe();
  });

  it("blocks admission while disable teardown is pending and reopens after verified cleanup", async () => {
    const { bridge, observe, manager } = fixture();
    await observe();
    const cleanup = deferred<void>();
    manager.stop.mockImplementationOnce(() => cleanup.promise);
    const stopping = bridge.stopAll();
    await expect(observe({ ...identity, botId: "new-bot" })).rejects.toThrow("stopping");
    cleanup.resolve();
    await stopping;
    await observe({ ...identity, botId: "new-bot" });
  });

  it("aborts pending work when a higher fence replaces the same logical run", async () => {
    const { dispatch, base, observe, manager } = fixture();
    const started = deferred<AbortSignal>();
    manager.pageBrowser.mockImplementationOnce(async (_scope, _command, signal) => {
      started.resolve(signal);
      return aborted(signal);
    });
    const pending = dispatch({
      ...base(),
      method: "browserPage",
      runId: "run",
      screenLeaseId: "run:1",
      command: { command: "snapshot" },
    });
    const rejected = expect(pending).rejects.toBeDefined();
    const signal = await started.promise;
    await observe(identity, computer.botId, "run", 2);
    expect(signal.aborted).toBe(true);
    await rejected;
  });

  it("keeps a revoked registration blocked while permitting a replacement registration", async () => {
    const { dispatch, observe, viewer, request } = fixture();
    const old = await viewer();
    const replacement = { ...identity, registrationId: "replacement" };
    const current = await viewer(false, replacement);
    await dispatch({
      method: "browserRevokeScope",
      botId: "setup",
      scope: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        registrationId: identity.registrationId!,
      },
    });
    expect((await request(old.replace("embed.html", "frame"))).statusCode).toBe(403);
    expect((await request(current.replace("embed.html", "frame"))).statusCode).toBe(200);
    await expect(observe()).rejects.toThrow("stopping");
    await observe(replacement);
  });

  it("expires old viewer capabilities without creating browser work", async () => {
    const { viewer, request, manager } = fixture();
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const url = await viewer();
      time.mockReturnValue(now + 60 * 60_000);
      expect((await request(url.replace("embed.html", "frame"))).statusCode).toBe(403);
      expect(manager.preview).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  });
});
