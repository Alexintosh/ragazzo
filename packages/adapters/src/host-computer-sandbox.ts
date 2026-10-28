import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  WorkspaceDirectoryRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { computerObservation } from "./computer-support.js";
import { describeDesktopSandbox } from "./desktop-sandbox.js";
import type { HostBrowserImage } from "./host-browser.js";
import type { HostBrowserIdentity } from "./host-browser-protocol.js";
import {
  HOST_COMPUTER_STOPPED_MESSAGE,
  HostComputerUnavailableError,
  isHostConnectionUnavailable,
  NATIVE_CODEX_CLEANUP_FAILED_MESSAGE,
} from "./host-computer-errors.js";
import type {
  HostComputerEnvironment,
  HostComputerFrame,
  HostComputerRequest,
} from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
} from "./host-computer-protocol.js";

export type HostComputerCredentials = {
  url: string;
  token: string;
  validate?: () => Promise<void>;
};
export type HostComputerCredentialResolver = (
  request: HostComputerRequest,
  context: AdapterContext,
) => Promise<HostComputerCredentials>;

/** Authenticated native host transport. Commands are never retried after a lost response. */
export class HostComputerSandbox implements SandboxProvider {
  readonly nativeWriteScopes = true;
  constructor(
    private readonly url: string | HostComputerCredentialResolver,
    private readonly token?: string,
  ) {}
  describe() {
    const base = describeDesktopSandbox();
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        graphical: true,
        browserOnly: true,
        takeover: true,
        multiScreen: true,
      },
    };
  }

  private browserScope(computer: ComputerRef, context: AdapterContext): HostBrowserIdentity {
    if (!context.botId || !context.userId || !context.spaceId)
      throw new Error("Browser requires an owned bot context");
    return {
      botId: context.botId,
      userId: context.userId,
      spaceId: context.spaceId,
      mode: computer.scope ?? "dedicated",
      registrationId: computer.registeredHostId ?? null,
    };
  }
  private browserBase(computer: ComputerRef, context: AdapterContext) {
    return {
      botId: computer.botId,
      scope: this.browserScope(computer, context),
      screenLeaseId: context.screenLeaseId,
    };
  }

  async *request<T>(input: HostComputerRequest, context: AdapterContext): AsyncIterable<T> {
    const credentials: HostComputerCredentials =
      typeof this.url === "function"
        ? await this.url(input, context)
        : { url: this.url, token: this.token ?? "" };
    if (!credentials.url || !credentials.token)
      throw new Error("Host access is not configured. Configure and enable the host bridge.");
    const body = JSON.stringify({
      ...input,
      runId:
        input.method === "browserRevokeScope"
          ? undefined
          : input.method.startsWith("codex")
            ? input.runId
            : context.runId,
    });
    if (Buffer.byteLength(body) > HOST_COMPUTER_MAX_BYTES)
      throw new Error("Local computer request is too large");
    const revoked = new AbortController();
    const signal = AbortSignal.any([
      revoked.signal,
      context.signal,
      AbortSignal.timeout(hostComputerDeadlineMs(input)),
    ]);
    let checking = false;
    const monitor = credentials.validate
      ? setInterval(() => {
          if (checking) return;
          checking = true;
          void credentials.validate!()
            .catch(() => {
              revoked.abort(new Error("Registered host access is revoked or unavailable"));
            })
            .finally(() => {
              checking = false;
            });
        }, 1000)
      : undefined;
    monitor?.unref();
    let response: Response;
    let connecting = false;
    try {
      // Secret loading or queued work may outlive a registration's revocation.
      await credentials.validate?.();
      signal.throwIfAborted();
      connecting = true;
      response = await fetch(new URL("/computer", credentials.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body,
        signal,
        redirect: "error",
      });
    } catch (error) {
      clearInterval(monitor);
      const setupRequest =
        ["provision", "prepare", "isRunning", "browserScreen", "browserControl"].includes(
          input.method,
        ) ||
        (input.method === "workspaceDirectories" && input.directories.action === "ensure");
      if (connecting && setupRequest && !signal.aborted && isHostConnectionUnavailable(error))
        throw new HostComputerUnavailableError({ cause: error });
      throw error;
    }
    if (!response.ok || !response.body) {
      clearInterval(monitor);
      await response.body?.cancel();
      throw new Error(
        "Host computer unavailable. Check the host connection and enable host access locally.",
      );
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          signal.throwIfAborted();
          if (newline > HOST_COMPUTER_MAX_BYTES)
            throw new Error("Local computer response is too large");
          const frame = JSON.parse(pending.slice(0, newline)) as HostComputerFrame<T>;
          pending = pending.slice(newline + 1);
          if ("error" in frame) {
            const error = new Error(frame.error.split(credentials.token).join("[redacted]"));
            // Only an explicit stopped-screen response permits stale-reference recovery.
            if (input.method === "browserScreen" && frame.error === HOST_COMPUTER_STOPPED_MESSAGE)
              error.name = "SandboxNotFoundError";
            throw error;
          }
          if ("heartbeat" in frame) {
            newline = pending.indexOf("\n");
            continue;
          }
          if ("done" in frame) {
            return;
          }
          yield frame.value;
          newline = pending.indexOf("\n");
        }
        if (pending.length > HOST_COMPUTER_MAX_BYTES)
          throw new Error("Local computer response is too large");
      }
      throw new Error("Local computer disconnected. Check the result before retrying.");
    } finally {
      clearInterval(monitor);
      signal.removeEventListener("abort", abort);
      const cancellation = reader.cancel().catch(() => undefined);
      if (!signal.aborted) await cancellation;
      reader.releaseLock();
    }
  }
  private async one<T>(input: HostComputerRequest, context: AdapterContext): Promise<T> {
    let result: T | undefined;
    for await (const value of this.request<T>(input, context)) result = value;
    return result as T;
  }
  environment(computer: ComputerRef, context: AdapterContext) {
    return this.one<HostComputerEnvironment>(
      { method: "environment", botId: computer.botId },
      context,
    );
  }
  provision(input: { botId: string; homePath: string }, context: AdapterContext) {
    return this.one<ComputerRef>({ method: "provision", botId: input.botId }, context);
  }
  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "prepare", botId: computer.botId }, context);
  }
  isRunning(computer: ComputerRef, context: AdapterContext) {
    return this.one<boolean>({ method: "isRunning", botId: computer.botId }, context);
  }
  execute(computer: ComputerRef, command: CommandRequest, context: AdapterContext) {
    return this.request<ProcessEvent>(
      {
        method: "execute",
        botId: computer.botId,
        command: { ...command, timeoutMs: boundedSandboxCommandTimeoutMs(command.timeoutMs) },
      },
      context,
    );
  }
  workspaceDirectories(
    computer: ComputerRef,
    directories: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return this.one<string[]>(
      { method: "workspaceDirectories", botId: computer.botId, directories },
      context,
    );
  }
  async cancelRunWork(
    computer: ComputerRef,
    _computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    const receipt = await this.one<{ cleanupVerified?: boolean } | null>(
      {
        method: "cancelRunWork",
        botId: computer.botId,
        targetRunId: runId,
        requireCleanup: context.requireRunCleanup,
      },
      context,
    );
    // Older hosts strip unknown request flags. Require an explicit proof frame
    // so their ordinary best-effort acknowledgement cannot admit recovery.
    if (context.requireRunCleanup && receipt?.cleanupVerified !== true)
      throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
  }
  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.one<ComputerFileEntry[]>(
      { method: "listFiles", botId: computer.botId, path },
      context,
    );
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const content = await this.one<string>(
      {
        method: "readFile",
        botId: computer.botId,
        path,
        maxBytes: Math.min(
          options?.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          HOST_COMPUTER_MAX_FILE_BYTES,
        ),
      },
      context,
    );
    return new Uint8Array(Buffer.from(content, "base64"));
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.one(
      {
        method: "writeFile",
        botId: computer.botId,
        file: { ...file, content: Buffer.from(file.content).toString("base64") },
      },
      context,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    for await (const file of this.request<{ path: string; content: string; executable?: boolean }>(
      { method: "exportWorkspace", botId: computer.botId },
      context,
    )) {
      yield { ...file, content: new Uint8Array(Buffer.from(file.content, "base64")) };
    }
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }
  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.one<{ id: string; createdAt: string }>(
      { method: "snapshot", botId: computer.botId },
      context,
    );
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "stop", botId: computer.botId }, context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "destroy", botId: computer.botId }, context);
  }
  pageBrowser(computer: ComputerRef, command: PageBrowserCommand, context: AdapterContext) {
    return this.one<PageBrowserResult>(
      { ...this.browserBase(computer, context), method: "browserPage", command },
      context,
    );
  }
  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const input: HostComputerRequest = {
      ...this.browserBase(computer, context),
      method: "browserScreen",
      interactive: request.interactive === true,
      controlToken: request.controlToken,
    };
    const credentials =
      typeof this.url === "function"
        ? await this.url(input, context)
        : { url: this.url, token: this.token ?? "" };
    const pinned = new HostComputerSandbox(async () => credentials);
    if (request.interactive) {
      if (!request.controlToken) throw new Error("Interactive browser requires a control token");
      await pinned.setScreenControl(computer, true, context, request.controlToken);
    }
    const result = await pinned.one<{ path: string }>(input, context);
    if (!/^\/browser-screen\/[a-f0-9]{64}\/embed\.html$/.test(result.path))
      throw new Error("Invalid host browser preview");
    return {
      url: new URL(result.path, credentials.url).href,
      mimeType: "text/html",
      headers: { Authorization: `Bearer ${credentials.token}` },
      close: async () => {},
    };
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    await this.one(
      {
        ...this.browserBase(computer, context),
        method: "browserControl",
        interactive,
        controlToken,
      },
      context,
    );
  }
  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    await this.one(
      {
        ...this.browserBase(computer, context),
        method: "browserRelease",
        keepWarm: context.keepScreenWarm,
        cancel: context.cancelRunWork,
      },
      context,
    );
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    if (lease.holder !== "bot")
      throw new Error("User browser input requires the authorized control preview");
    await this.act(computer, { actions: [input] }, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const image = await this.one<HostBrowserImage>(
      { ...this.browserBase(computer, context), method: "browserObserve" },
      context,
    );
    return computerObservation(Buffer.from(image.data, "base64"), {
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
    });
  }
  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const result = await this.one<{ completed: number; image?: HostBrowserImage }>(
      { ...this.browserBase(computer, context), method: "browserAct", request },
      context,
    );
    return {
      completed: result.completed,
      ...(result.image
        ? {
            observation: computerObservation(Buffer.from(result.image.data, "base64"), {
              mimeType: result.image.mimeType,
              width: result.image.width,
              height: result.image.height,
            }),
          }
        : {}),
    };
  }
}
