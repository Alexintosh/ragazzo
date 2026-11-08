import { createHash } from "node:crypto";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostCommandLifecycle } from "./host-command-lifecycle.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
const token = "ab".repeat(32);
const nodeEnv: Record<string, string> = process.versions.electron
  ? { ELECTRON_RUN_AS_NODE: "1" }
  : {};
const collect = async (events: AsyncIterable<ProcessEvent>) => {
  for await (const _event of events) {
    /* drain */
  }
};

describe("generic host command revocation", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startHostComputerServer>>;
  let client: HostComputerSandbox;
  let computer: ComputerRef;
  async function start() {
    server = await startHostComputerServer({
      root,
      token,
      hostname: "127.0.0.1",
      writeScopeRoot: path.join(root, "write-scopes"),
    });
    server.setEnabled(true);
    client = new HostComputerSandbox(`http://127.0.0.1:${server.port}`, token);
    computer = await client.provision({ botId: "test-computer", homePath: "/unused" }, context);
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "host-revocation-")));
    await start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("finishing one parallel command preserves another command in the same run", async () => {
    const sameRun = { ...context, runId: "parallel-run" };
    const output: string[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const long = (async () => {
      for await (const event of client.execute(
        computer,
        {
          env: nodeEnv,
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('ready');setTimeout(()=>process.stdout.write('long-finished'),500)",
          ],
        },
        sameRun,
      )) {
        if (event.type === "stdout") {
          output.push(event.data);
          if (event.data.includes("ready")) ready();
        }
      }
    })();
    await started;
    await collect(
      client.execute(
        computer,
        { env: nodeEnv, argv: [process.execPath, "-e", "process.stdout.write('short-finished')"] },
        sameRun,
      ),
    );
    await long;
    expect(output.join("")).toContain("long-finished");
  });

  it("rejects delayed commands, writes and directory mutations after cleanup and restart", async () => {
    await client.cancelRunWork(computer, "computer", "revoked-run", {
      ...context,
      requireRunCleanup: true,
    });
    await server.close();
    await start();
    const revoked = { ...context, runId: "revoked-run" };
    const marker = path.join(root, "delayed-command");
    await expect(
      collect(
        client.execute(
          computer,
          {
            env: nodeEnv,
            argv: [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
            ],
          },
          revoked,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      client.writeFile(computer, { path: "delayed-write", content: new Uint8Array([1]) }, revoked),
    ).rejects.toThrow();
    await expect(
      client.workspaceDirectories(computer, { action: "ensure", paths: ["bots/delayed"] }, revoked),
    ).rejects.toThrow();
    const home = path.join(
      root,
      "desktop-computers",
      createHash("sha256").update(computer.botId).digest("hex"),
    );
    for (const target of [
      marker,
      path.join(home, "delayed-write"),
      path.join(home, "bots/delayed"),
    ])
      await expect(access(target)).rejects.toThrow();
    await client.writeFile(
      computer,
      { path: "sibling", content: new Uint8Array([1]) },
      { ...context, runId: "sibling-run" },
    );
  });

  it("waits for a pending owned write before strict cleanup can acknowledge", async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = DesktopSandboxProvider.prototype.writeFile;
    vi.spyOn(DesktopSandboxProvider.prototype, "writeFile").mockImplementation(async function (
      this: DesktopSandboxProvider,
      computer,
      file,
    ) {
      started();
      await held;
      await write.call(this, computer, file);
    });
    const writing = client.writeFile(
      computer,
      { path: "in-flight", content: new Uint8Array([1]) },
      { ...context, runId: "write-run" },
    );
    const rejected = expect(writing).rejects.toThrow();
    await entered;
    let acknowledged = false;
    const cleanup = client
      .cancelRunWork(computer, "computer", "write-run", { ...context, requireRunCleanup: true })
      .then(() => {
        acknowledged = true;
      });
    try {
      await rejected; // The fence aborted the write's HTTP connection.
      expect(acknowledged).toBe(false);
    } finally {
      release();
    }
    await cleanup;
    expect(acknowledged).toBe(true);
    expect(await client.readFile(computer, "in-flight", context)).toEqual(new Uint8Array([1]));
  });

  it("refuses strict cleanup for an unresolved generic command journal without killing unrelated PIDs", async () => {
    const key = createHash("sha256").update(computer.botId).digest("hex");
    await new HostCommandLifecycle(root).begin(key, "orphan-run", context.signal, vi.fn());
    const kill = vi.spyOn(process, "kill");
    await expect(
      client.cancelRunWork(computer, "computer", "orphan-run", {
        ...context,
        requireRunCleanup: true,
      }),
    ).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});
