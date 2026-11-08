import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { createAcpClientFactory } from "./acp-client.js";
import { createClaudeClientFactory } from "./claude-client.js";
import { createCodexClientFactory } from "./codex-app-server.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostBrowserManager } from "./host-browser.js";
import { HostBrowserBridge } from "./host-browser-bridge.js";
import type { HostBrowserRequest } from "./host-browser-protocol.js";
import { HostCodexBroker } from "./host-codex-broker.js";
import { HostCommandLifecycle } from "./host-command-lifecycle.js";
import { HOST_COMPUTER_STOPPED_MESSAGE, hostComputerErrorMessage } from "./host-computer-errors.js";
import type { HostComputerFrame, HostComputerRequest } from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./host-computer-protocol.js";
import { listHostDirectories } from "./host-directories.js";
import { resolveHostProjectDirectory } from "./host-project-directory.js";
import type { HostScreen } from "./host-screen.js";
import { HostScreenError } from "./host-screen.js";
import { readNativeProviderConfiguration } from "./native-provider-config.js";
import { NativeSetupManager } from "./native-setup.js";
import { NativeWriteScopes } from "./native-write-scope.js";

/** Where one request's frames go. A write may wait for the transport to drain. */
export interface HostComputerSink {
  /** Called once the request is accepted, before the first frame. */
  open(): void;
  write(frame: HostComputerFrame<unknown>): void | Promise<void>;
}

export type HostComputerOutcome = "invalid" | "disabled" | "busy" | "finished";

export interface HostComputerCall {
  readonly signal: AbortSignal;
  abort(): void;
  /** Validates and runs one request. Nothing is written after the call is aborted. */
  run(input: unknown, sink: HostComputerSink): Promise<HostComputerOutcome>;
  /** Releases the slot. Always call it, even when `run` was never reached. */
  end(): void;
}

/**
 * Runs host computer requests from any transport: the local HTTP listener and the outbound
 * device socket share validation, limits, cancellation, and error sanitizing.
 */
export function createHostComputerRunner(options: {
  root: string;
  screen?: HostScreen;
  writeScopeRoot?: string;
  browserManager?: HostBrowserManager;
}) {
  let enabled = false;
  const active = new Map<
    AbortController,
    { botId: string; runId?: string; method: string } | undefined
  >();
  const provider = new DesktopSandboxProvider({
    root: options.root,
    hostRoots: [homedir()],
    maxFileBytes: HOST_COMPUTER_MAX_FILE_BYTES,
  });

  const writeScopes = new NativeWriteScopes(options.writeScopeRoot);
  const commands = new HostCommandLifecycle(options.root);
  const browsers = new HostBrowserBridge(
    options.browserManager ??
      new HostBrowserManager({ root: path.join(options.root, "host-browsers") }),
  );
  let browserRequests = 0;
  let stoppingBrowsers: Promise<void> | undefined;
  const browserComputerStops = new Map<string, () => void>();
  const codex = new HostCodexBroker(
    path.join(options.root, "native-codex"),
    createCodexClientFactory(options.root),
    path.join(options.root, "desktop-computers"),
    writeScopes,
  );
  let nativeConfig: Awaited<ReturnType<typeof readNativeProviderConfiguration>> = {};
  const ready = readNativeProviderConfiguration(options.root).then((config) => {
    nativeConfig = config;
  });
  // The HTTP entry point awaits this before listening; other transports await it at dispatch.
  void ready.catch(() => undefined);
  const claude = new HostCodexBroker(
    path.join(options.root, "native-claude"),
    createClaudeClientFactory(options.root),
    path.join(options.root, "desktop-computers"),
    writeScopes,
  );
  const acp = new HostCodexBroker(
    path.join(options.root, "native-acp"),
    (...args) => {
      if (!nativeConfig.acp) throw new Error("ACP is not configured on this host");
      return createAcpClientFactory(nativeConfig.acp)(...args);
    },
    path.join(options.root, "desktop-computers"),
    writeScopes,
  );
  const brokers = [codex, claude, acp];
  const setup = new NativeSetupManager({
    root: options.root,
    status: (kind) => (kind === "codex" ? codex : kind === "claude" ? claude : acp).status(),
  });
  const stopNative = async (botId: string, runId?: string, requireCleanup?: boolean) => {
    const results = await Promise.allSettled(
      brokers.map((broker) => broker.stopBot(botId, runId, requireCleanup)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const closeNative = async () => {
    const results = await Promise.allSettled(brokers.map((broker) => broker.close()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  // Reconstruct only our own workspace path. Never trust a caller's providerRef or filesystem root.
  function ref(botId: string): ComputerRef {
    const key = createHash("sha256").update(botId).digest("hex");
    return {
      id: `desktop-${key}`,
      botId: key,
      kind: "desktop",
      providerRef: path.join(options.root, "desktop-computers", key),
    };
  }

  // A persisted workspace survives bridge restarts, but its live browser/command ownership does not.
  const isRunning = (computer: ComputerRef, context: AdapterContext) =>
    provider.boxes.has(computer.id) && provider.isRunning(computer, context);

  function screen() {
    if (!options.screen)
      throw new HostScreenError("Screen control is not available on this computer.");
    return options.screen;
  }

  async function* dispatch(
    input: HostComputerRequest,
    context: AdapterContext,
  ): AsyncIterable<unknown> {
    await ready;
    const computer = ref(input.botId);
    const beginMutation = (runId = context.runId ?? randomUUID()) =>
      commands.begin(computer.botId, runId, context.signal, () => {
        for (const controller of active.keys())
          if (controller.signal === context.signal) controller.abort();
      });
    const nativeKind = "nativeKind" in input ? (input.nativeKind ?? "codex") : "codex";
    const native = nativeKind === "claude" ? claude : nativeKind === "acp" ? acp : codex;
    if (input.method.startsWith("browser")) {
      if (!("scope" in input)) throw new Error("Browser scope required");
      const browserInput = input as HostBrowserRequest;
      if (stoppingBrowsers && input.method !== "browserRevokeScope")
        throw new Error("Host browser is stopping");
      if (input.method === "browserScreen" && !(await isRunning(computer, context)))
        throw new Error(HOST_COMPUTER_STOPPED_MESSAGE);
      if (["browserPage", "browserObserve", "browserAct"].includes(input.method)) {
        const lease = await beginMutation();
        try {
          if (!(await isRunning(computer, context)))
            throw new Error("Local computer stopped");
          await lease.check();
          yield await browsers.dispatch(browserInput, computer, context.signal);
        } finally {
          await lease.finish(true);
        }
      } else yield await browsers.dispatch(browserInput, computer, context.signal);
      return;
    }
    if (!native && input.method.startsWith("codex")) {
      if (input.method === "codexStatus") {
        yield { available: false, authenticated: false, reason: "cli-unavailable" };
        return;
      }
      throw new Error("ACP is not configured on this host");
    }
    const scope = { botId: input.botId, signal: context.signal };
    switch (input.method) {
      case "screenObserve":
        yield await screen().observe(scope, input.app, { query: input.query });
        break;
      case "screenAct":
        yield await screen().act(scope, input.app, input.actions);
        break;
      case "hostProjectDirectory":
        yield { path: await resolveHostProjectDirectory(input.path, context.signal) };
        break;
      case "hostDirectories":
        yield await listHostDirectories(input.path, homedir(), context.signal);
        break;
      case "nativeSetup":
        yield await setup.request(input);
        break;
      case "nativeSetupScopeRevoke":
        await setup.revokeScope(input.scopeKey);
        yield { revoked: true };
        break;
      case "nativeSetupRevoke":
        await setup.revoke(input.registrationId);
        yield { revoked: true };
        break;
      case "codexStatus":
        yield await native!.status();
        break;
      case "codexModels":
        if (nativeKind !== "codex") throw new Error("Runtime model selection is unavailable");
        yield await codex.models(input.projectPath);
        break;
      case "codexRunModelSettings":
        if (nativeKind !== "codex") throw new Error("Runtime model selection is unavailable");
        yield* codex.run({ ...input, method: "codexRun" }, context.signal);
        break;
      case "codexRun":
        yield* native!.run(input, context.signal);
        break;
      case "codexRunScoped":
        if (!input.config.writeSubdirectory) throw new Error("Native task write scope is required");
        yield* native!.run({ ...input, method: "codexRun" }, context.signal);
        break;
      case "codexRunContextScoped":
        if (!input.config.contextScope) throw new Error("Native context scope is required");
        yield* native!.run({ ...input, method: "codexRun" }, context.signal);
        break;
      case "codexToolResult":
        native!.toolResult(input, input.callId, input.response);
        yield null;
        break;
      case "codexAnswer":
        native!.answer(input, input.approvalId, input.answer);
        yield null;
        break;
      case "codexSteer":
        yield await native!.steer(input);
        break;
      case "codexRetire":
        await native!.retireRun(input, input.computerKey);
        yield { cleanupVerified: true };
        break;
      case "codexAbort":
        await native!.abort(input);
        yield null;
        break;
      case "environment":
        yield await provider.environment();
        break;
      case "provision": {
        const result = await provider.provision({ botId: computer.botId, homePath: "" }, context);
        yield { ...result, botId: input.botId, providerRef: `host:${computer.botId}` };
        break;
      }
      case "isRunning":
        yield await isRunning(computer, context);
        break;
      case "prepare":
        await provider.prepare(computer, context);
        yield null;
        break;
      case "execute":
        {
          const logicalRunId = context.runId ?? randomUUID();
          // Parallel tools share a run, but completion owns only this command's process tree.
          const commandRunId = `command:${randomUUID()}`;
          const commandContext = { ...context, runId: commandRunId };
          const lease = await beginMutation(logicalRunId);
          let release: (() => Promise<void>) | undefined;
          let verified = true;
          try {
            if (!(await isRunning(computer, context)))
              throw new Error("Local computer stopped");
            release = await writeScopes.acquire(
              `host-command:${randomUUID()}`,
              null,
              lease.stopped,
              logicalRunId,
            );
            verified = false;
            await lease.check();
            yield* provider.execute(computer, input.command, commandContext);
          } finally {
            try {
              if (release) {
                // Confirm actual process death before releasing the write guard or journal.
                await provider.cancelRunWork(computer, computer.id, commandRunId, commandContext);
                await release();
                verified = true;
              }
            } finally {
              await lease.finish(verified);
            }
          }
        }
        break;
      case "workspaceDirectories":
        {
          // Directory operations are already restricted to this computer's home.
          const lease = await beginMutation();
          let release: (() => Promise<void>) | undefined;
          let verified = true;
          try {
            release = await writeScopes.acquire(
              `host-directories:${randomUUID()}`,
              computer.providerRef,
              lease.stopped,
              context.runId,
            );
            verified = false;
            await lease.check();
            yield await provider.workspaceDirectories(computer, input.directories, context);
          } finally {
            try {
              if (release) {
                await release();
                verified = true;
              }
            } finally {
              await lease.finish(verified);
            }
          }
        }
        break;
      case "cancelRunWork": {
        const commandRunIds = [...new Set([input.targetRunId, input.runId ?? input.targetRunId])];
        for (const runId of commandRunIds) await commands.fence(computer.botId, runId);
        try {
          const stopped = await Promise.allSettled([
            browsers.cancelRun(input.botId, commandRunIds),
            stopNative(input.botId, input.targetRunId, input.requireCleanup),
          ]);
          const failure = stopped.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        } finally {
          await provider.cancelRunWork(computer, computer.id, input.targetRunId, context);
          for (const [controller, work] of active) {
            if (
              work?.method === "execute" &&
              work.botId === input.botId &&
              commandRunIds.includes(work.runId ?? "")
            )
              controller.abort();
          }
          for (const runId of commandRunIds) await commands.drain(computer.botId, runId);
        }
        yield input.requireCleanup ? { cleanupVerified: true } : null;
        break;
      }
      case "listFiles":
        yield await provider.listFiles(computer, input.path, context);
        break;
      case "readFile":
        yield Buffer.from(
          await provider.readFile(computer, input.path, context, {
            maxBytes: input.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          }),
        ).toString("base64");
        break;
      case "writeFile":
        {
          // writeFile's contained-parent walk refuses symlink and absolute escapes.
          const lease = await beginMutation();
          let release: (() => Promise<void>) | undefined;
          let verified = true;
          try {
            release = await writeScopes.acquire(
              `host-write:${randomUUID()}`,
              computer.providerRef,
              lease.stopped,
              context.runId,
            );
            verified = false;
            await lease.check();
            await provider.writeFile(computer, {
              ...input.file,
              content: Buffer.from(input.file.content, "base64"),
            });
          } finally {
            try {
              if (release) {
                await release();
                verified = true;
              }
            } finally {
              await lease.finish(verified);
            }
          }
        }
        yield null;
        break;
      case "exportWorkspace":
        for await (const file of provider.exportWorkspace(computer)) {
          if (file.content.byteLength > HOST_COMPUTER_MAX_FILE_BYTES)
            throw new Error(`computer file exceeds ${HOST_COMPUTER_MAX_FILE_BYTES} bytes`);
          yield { ...file, content: Buffer.from(file.content).toString("base64") };
        }
        break;
      case "snapshot":
        yield await provider.snapshot(computer, context);
        break;
      case "stop":
      case "destroy": {
        if (!browserComputerStops.has(input.botId))
          browserComputerStops.set(input.botId, browsers.beginComputerStop(input.botId));
        for (const [controller, work] of active)
          if (work?.botId === input.botId && controller.signal !== context.signal)
            controller.abort();
        let browserStopped = false;
        try {
          const stopped = await Promise.allSettled([
            browsers.stopComputer(input.botId),
            stopNative(input.botId),
          ]);
          const failure = stopped.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          browserStopped = true;
        } finally {
          for (const [controller, work] of active) {
            if (work?.botId === input.botId && controller.signal !== context.signal)
              controller.abort();
          }
          if (input.method === "destroy") await provider.destroy(computer, context);
          else await provider.stop(computer, context);
          if (browserStopped) {
            browserComputerStops.get(input.botId)?.();
            browserComputerStops.delete(input.botId);
          }
        }
        yield null;
        break;
      }
    }
  }
  return {
    ready,
    isEnabled: () => enabled,
    async serveBrowser(
      request: Parameters<typeof browsers.serve>[0],
      response: Parameters<typeof browsers.serve>[1],
    ) {
      if (!enabled || stoppingBrowsers) {
        response.writeHead(403).end();
        return;
      }
      if (browserRequests >= 16) {
        response.writeHead(429).end();
        return;
      }
      browserRequests++;
      try {
        await browsers.serve(request, response);
      } finally {
        browserRequests--;
      }
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        for (const controller of active.keys()) controller.abort();
        void provider.cancelAllCommands().catch(() => undefined);
        void setup.cancelAll().catch(() => undefined);
        void closeNative().catch(() => undefined);
        const cleanup = browsers.stopAll();
        stoppingBrowsers = cleanup;
        void cleanup.then(
          () => {
            if (stoppingBrowsers === cleanup) stoppingBrowsers = undefined;
          },
          () => {},
        );
      }
    },
    async close() {
      enabled = false;
      for (const controller of active.keys()) controller.abort();
      const results = await Promise.allSettled([
        provider.cancelAllCommands(),
        setup.close(),
        closeNative(),
        browsers.close(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    /** Reserves a slot before the request body arrives, or null when execution capacity is full. */
    begin(): HostComputerCall | null {
      // Keep four bounded slots for cancellation and shutdown when commands fill execution capacity.
      if (active.size >= 20) return null;
      const controller = new AbortController();
      active.set(controller, undefined);
      const signal = controller.signal;
      const abort = () => controller.abort();
      return {
        signal,
        abort,
        end: () => active.delete(controller),
        async run(input, sink) {
          if (!enabled && !setupRevocation(input)) return "disabled";
          const parsed = hostComputerRequest.safeParse(input);
          if (!parsed.success) return "invalid";
          if ((!enabled && !setupRevocation(parsed.data)) || signal.aborted) return "disabled";
          const lifecycle =
            parsed.data.method === "nativeSetupRevoke" ||
            parsed.data.method === "nativeSetupScopeRevoke" ||
            (parsed.data.method === "nativeSetup" && parsed.data.action === "cancel") ||
            parsed.data.method === "cancelRunWork" ||
            parsed.data.method === "codexAbort" ||
            parsed.data.method === "codexRetire" ||
            parsed.data.method === "codexAnswer" ||
            parsed.data.method === "codexToolResult" ||
            parsed.data.method === "codexSteer" ||
            parsed.data.method === "stop" ||
            parsed.data.method === "browserRevokeScope" ||
            parsed.data.method === "browserRelease" ||
            parsed.data.method === "browserControl" ||
            parsed.data.method === "destroy";
          if (!lifecycle && active.size > 16) return "busy";
          active.set(controller, {
            botId: parsed.data.botId,
            runId: parsed.data.runId,
            method: parsed.data.method,
          });
          const deadline = setTimeout(abort, hostComputerDeadlineMs(parsed.data));
          deadline.unref();
          sink.open();
          // Quiet commands must keep clients and intermediaries from timing out between frames.
          const heartbeat = setInterval(() => {
            if (!signal.aborted) void Promise.resolve(sink.write({ heartbeat: true })).catch(abort);
          }, 30_000);
          heartbeat.unref();
          try {
            const context: AdapterContext = {
              operationId: "desktop-host",
              traceId: "desktop-host",
              spaceId: "local",
              userId: "local",
              runId: parsed.data.runId,
              signal,
            };
            for await (const value of dispatch(parsed.data, context)) {
              if (signal.aborted) break;
              await sink.write({ value });
            }
            if (!signal.aborted) await sink.write({ done: true });
          } catch (error) {
            if (!signal.aborted)
              await Promise.resolve(
                sink.write({
                  error:
                    error instanceof HostScreenError
                      ? error.message
                      : hostComputerErrorMessage(error),
                }),
              ).catch(() => undefined);
          } finally {
            clearTimeout(deadline);
            clearInterval(heartbeat);
          }
          return "finished";
        },
      };
    },
  };
}

function setupRevocation(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "method" in input &&
    (input.method === "nativeSetupRevoke" ||
      input.method === "nativeSetupScopeRevoke" ||
      input.method === "browserRevokeScope")
  );
}
