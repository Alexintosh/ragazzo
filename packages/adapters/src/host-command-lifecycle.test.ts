import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCommandLifecycle } from "./host-command-lifecycle.js";

describe("host command lifecycle", () => {
  let root: string;
  let commands: HostCommandLifecycle;
  const signal = new AbortController().signal;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "host-command-lifecycle-")));
    commands = new HostCommandLifecycle(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fences delayed mutations across restarts without affecting sibling runs or computers", async () => {
    await commands.fence("computer", "cancelled");
    await commands.drain("computer", "cancelled");
    commands = new HostCommandLifecycle(root);
    await expect(commands.begin("computer", "cancelled", signal, vi.fn())).rejects.toThrow(
      "cancelled",
    );
    const sibling = await commands.begin("computer", "sibling", signal, vi.fn());
    const other = await commands.begin("other-computer", "cancelled", signal, vi.fn());
    await sibling.check();
    await other.check();
    await sibling.finish(true);
    await other.finish(true);
  });

  it("aborts pending requests and waits for their cleanup before acknowledging", async () => {
    const controller = new AbortController();
    let directory: string;
    const abort = vi.fn(() => {
      expect(JSON.parse(readFileSync(path.join(directory, "cancelled.json"), "utf8"))).toEqual({
        version: 1,
      });
      controller.abort();
    });
    const pending = await commands.begin("computer", "run", controller.signal, abort);
    const base = path.join(root, "host-command-lifecycle");
    directory = path.join(base, (await readdir(base))[0]!);
    await commands.fence("computer", "run");
    expect(abort).toHaveBeenCalledOnce();
    expect(pending.stopped()).toBe(true);
    await expect(pending.check()).rejects.toThrow("cancelled");
    let drained = false;
    const draining = commands.drain("computer", "run").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await pending.finish(true);
    await draining;
  });

  it("rejects strict cleanup and new effects for unresolved restart journals without signalling PIDs", async () => {
    await commands.begin("computer", "run", signal, vi.fn());
    commands = new HostCommandLifecycle(root);
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(commands.begin("computer", "run", signal, vi.fn())).rejects.toThrow(
        "cleanup uncertain",
      );
      await commands.fence("computer", "run");
      await expect(commands.drain("computer", "run")).rejects.toThrow("cleanup uncertain");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("retains uncertain teardown journals for later recovery attempts", async () => {
    const pending = await commands.begin("computer", "run", signal, vi.fn());
    await commands.fence("computer", "run");
    await pending.finish(false);
    await expect(commands.drain("computer", "run")).rejects.toThrow("cleanup uncertain");
    await expect(new HostCommandLifecycle(root).drain("computer", "run")).rejects.toThrow(
      "cleanup uncertain",
    );
  });

  it("fails closed on malformed persisted fences", async () => {
    await commands.fence("computer", "run");
    const base = path.join(root, "host-command-lifecycle");
    const [directory] = await readdir(base);
    await writeFile(path.join(base, directory!, "cancelled.json"), "broken");
    await expect(
      new HostCommandLifecycle(root).begin("computer", "run", signal, vi.fn()),
    ).rejects.toThrow();
  });
});

import { readFileSync } from "node:fs";
