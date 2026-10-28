import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
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
import type { HostComputerRequest } from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./host-computer-protocol.js";
import { listHostDirectories } from "./host-directories.js";
import { resolveHostProjectDirectory } from "./host-project-directory.js";
import { readNativeProviderConfiguration } from "./native-provider-config.js";
import { NativeSetupManager } from "./native-setup.js";
import { NativeWriteScopes } from "./native-write-scope.js";

/** No renderer receives the credential. Docker reaches this listener through its host gateway. */
export async function startHostComputerServer(options: {
  root: string;
  token: string;
  port?: number;
  hostname?: string;
  /** Explicit private coordinator directory; production defaults span state roots. */
  writeScopeRoot?: string;
  /** Deterministic offline browser seam; production uses an owned installed Chrome. */
  browserManager?: HostBrowserManager;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Invalid local computer credential");
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
  const nativeConfig = await readNativeProviderConfiguration(options.root);
  const claude = new HostCodexBroker(
    path.join(options.root, "native-claude"),
    createClaudeClientFactory(options.root),
    path.join(options.root, "desktop-computers"),
    writeScopes,
  );
  const acp = new HostCodexBroker(
    path.join(options.root, "native-acp"),
    nativeConfig.acp
      ? createAcpClientFactory(nativeConfig.acp)
      : () => {
          throw new Error("ACP is not configured on this host");
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
  const secret = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (request, response) => {
    const credential = Buffer.from(request.headers.authorization ?? "");
    // Reject browser-origin requests even when they somehow obtain a credential; no CORS.
    if (
      request.headers.origin ||
      credential.length !== secret.length ||
      !timingSafeEqual(credential, secret)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url?.startsWith("/browser-screen/")) {
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
      return;
    }
    if (request.method !== "POST" || request.url !== "/computer") {
      response.writeHead(404).end();
      return;
    }
    // Keep four bounded slots for cancellation and shutdown when commands fill execution capacity.
    if (active.size >= 20) {
      response.writeHead(429).end();
      return;
    }
    const controller = new AbortController();
    active.set(controller, undefined);
    controller.signal.addEventListener("abort", () => response.destroy(), { once: true });
    const abort = () => controller.abort();
    response.once("close", abort);
    let heartbeat: NodeJS.Timeout | undefined;
    let timer = setTimeout(abort, 30_000);
    timer.unref();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HOST_COMPUTER_MAX_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Cleanup must remain reachable when consent was never granted or was disabled.
      // Authenticate and bound the body first; only these two methods bypass consent.
      if (!enabled && !setupRevocation(input)) {
        response.writeHead(403).end();
        return;
      }
      const parsed = hostComputerRequest.safeParse(input);
      if (!parsed.success) {
        response.writeHead(400).end();
        return;
      }
      if ((!enabled && !setupRevocation(parsed.data)) || controller.signal.aborted) {
        response.writeHead(403).end();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(abort, hostComputerDeadlineMs(parsed.data));
      timer.unref();
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
      if (!lifecycle && active.size > 16) {
        response.writeHead(429).end();
        return;
      }
      active.set(controller, {
        botId: parsed.data.botId,
        runId: parsed.data.runId,
        method: parsed.data.method,
      });
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      response.flushHeaders();
      // Quiet commands must keep HTTP clients and intermediaries from timing out between frames.
      heartbeat = setInterval(() => {
        if (!controller.signal.aborted && !response.destroyed)
          response.write(`${JSON.stringify({ heartbeat: true })}\n`);
      }, 30_000);
      heartbeat.unref();
      const context: AdapterContext = {
        operationId: "desktop-host",
        traceId: "desktop-host",
        spaceId: "local",
        userId: "local",
        runId: parsed.data.runId,
        signal: controller.signal,
      };
      for await (const value of dispatch(parsed.data, context)) {
        if (controller.signal.aborted) break;
        if (!response.write(`${JSON.stringify({ value })}\n`))
          await once(response, "drain", { signal: controller.signal });
      }
      if (!controller.signal.aborted) response.end(`${JSON.stringify({ done: true })}\n`);
    } catch (error) {
      const message = hostComputerErrorMessage(error);
      if (!response.headersSent) response.writeHead(400);
      if (!response.destroyed) response.end(`${JSON.stringify({ error: message })}\n`);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      active.delete(controller);
      response.removeListener("close", abort);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local computer unavailable");

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
  async function* dispatch(
    input: HostComputerRequest,
    context: AdapterContext,
  ): AsyncIterable<unknown> {
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
      if (input.method === "browserScreen" && !(await provider.isRunning(computer, context)))
        throw new Error(HOST_COMPUTER_STOPPED_MESSAGE);
      if (["browserPage", "browserObserve", "browserAct"].includes(input.method)) {
        const lease = await beginMutation();
        try {
          if (!(await provider.isRunning(computer, context)))
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
    switch (input.method) {
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
        yield await provider.isRunning(computer, context);
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
            if (!(await provider.isRunning(computer, context)))
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
    port: address.port,
    isEnabled: () => enabled,
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
      try {
        const results = await Promise.allSettled([
          provider.cancelAllCommands(),
          setup.close(),
          closeNative(),
          browsers.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
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
