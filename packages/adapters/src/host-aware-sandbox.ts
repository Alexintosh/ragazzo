import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { cancelComputerRunWork } from "./computer-idle.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { createHostComputerTransport } from "./registered-hosts.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

export function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient; secrets?: SecretStore },
): SandboxProvider {
  const host =
    opts.prisma && opts.secrets
      ? createHostComputerTransport({ ...opts, prisma: opts.prisma, secrets: opts.secrets })
      : new HostComputerSandbox(opts.hostComputerUrl ?? "", opts.hostComputerToken ?? "");
  if (kind === "desktop") {
    // A locally authorized bridge owns host execution in standalone deployments too.
    // The API/worker never gain direct host access merely by selecting this provider.
    if ((opts.prisma && opts.secrets) || (opts.hostComputerUrl && opts.hostComputerToken))
      return host;
    assertHostCommandsAllowed();
    return new DesktopSandboxProvider({
      root: opts.dataDir,
      hostRoots: [homedir()],
    });
  }
  const primary = createSandboxProvider(kind, opts);
  if (!opts.prisma) return primary;
  return new HostAwareSandbox(primary, host, async () => {
    const settings = await opts.prisma!.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    return settings?.computerHost === "this-mac";
  });
}

export class HostAwareSandbox implements SandboxProvider {
  get nativeWriteScopes() { return this.host.nativeWriteScopes === true && this.isolated.describe().id !== "desktop"; }
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: ComputerRef) {
    return computer.kind === "desktop" ? this.host : this.isolated;
  }

  async provisionKind(placement?: { executionTarget?: "default" | "docker" | "host" }) {
    // Explicit targets stay pinned; legacy default computers follow the deployment preference.
    if (placement?.executionTarget === "host") return "desktop";
    if (placement?.executionTarget === "docker")
      return this.isolated.describe().id as ComputerRef["kind"];
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    return provider.describe().id as ComputerRef["kind"];
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      executionTarget?: "default" | "docker" | "host";
      registeredHostId?: string | null;
    },
    context: AdapterContext,
  ) {
    const kind = await this.provisionKind({
      executionTarget: request.executionTarget,
    });
    const provider = kind === "desktop" ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    const provisioned = await provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
    return {
      ...provisioned,
      executionTarget: request.executionTarget,
      registeredHostId: request.registeredHostId,
    };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const kind = await this.provisionKind({
      executionTarget: computer.executionTarget,
    });
    const provider = kind === "desktop" ? this.host : this.isolated;
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    return this.route(computer).isStopped?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    const provider = this.route(computer);
    return provider.environment?.(computer, context);
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    // Explicit host placement is independent of the preference; local consent still lives
    // on the authenticated host service. Legacy default computers follow that preference.
    if (
      computer.kind === "desktop" &&
      computer.executionTarget !== "host" &&
      !(await this.hostEnabled())
    ) {
      throw new Error("Local computer access is disabled");
    }
    yield* this.route(computer).execute(computer, request, context);
  }

  workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(this.route(computer), computer, request, context);
  }

  cancelRunWork(computer: ComputerRef, computerId: string, runId: string, context: AdapterContext) {
    return cancelComputerRunWork(this.route(computer), computer, computerId, runId, context);
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.route(computer).connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = this.route(computer);
    if (!provider.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return provider.connectTerminal(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.route(computer).sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.route(computer).act(computer, request, context);
  }

  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.route(computer).listFiles(computer, path, context);
  }

  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return this.route(computer).readFile(computer, path, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.route(computer).writeFile(computer, file, context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext, limits?: WorkspaceExportLimits) {
    return this.route(computer).exportWorkspace(computer, context, limits);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.route(computer).importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).snapshot(computer, context);
  }

  billsWhileRunning(computer: ComputerRef): boolean {
    return this.route(computer).billsWhileRunning?.(computer) ?? false;
  }

  keepAlive(computer: ComputerRef) {
    return this.route(computer).keepAlive?.(computer) ?? Promise.resolve();
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext, options?: { discardUnsaved?: boolean }) {
    return this.route(computer).stop(computer, context, options);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).destroy(computer, context);
  }
}
