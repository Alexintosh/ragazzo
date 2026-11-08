import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RuntimeModels } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import type { CodexClient, CodexClientFactory, CodexMessage } from "./codex-app-server.js";
import {
  CodexRpcError,
  createCodexClient,
  initializeCodex,
  nativeCodexThreadConfig,
} from "./codex-app-server.js";
import { codexRuntimeModels } from "./codex-runtime-models.js";
import type {
  HostCodexEvent,
  HostCodexStatus,
  HostCodexSteeringResult,
} from "./host-codex-protocol.js";
import { NATIVE_CODEX_CLEANUP_FAILED_MESSAGE } from "./host-computer-errors.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { nativeIntroExecutionId } from "./native-context.js";

import type { NativeToolCall, NativeToolResponse } from "./native-tool-bridge.js";
import { canonicalWriteScope, NativeWriteScopes, scopesOverlap } from "./native-write-scope.js";

type RunInput = Extract<HostComputerRequest, { method: "codexRun" }>;
type Binding = { botId: string; threadId: string; runId: string };
type Question = {
  id: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  isSecret?: boolean;
};
type Interaction = {
  id: string;
  rpcId: string | number;
  kind: "question" | "approval";
  questions?: Question[];
  answers: Record<string, { answers: string[] }>;
  index: number;
  detail?: string;
};
type Run = {
  writeRoot?: string;
  releaseWriteScope?: () => Promise<void>;
  input: RunInput;
  client?: CodexClient;
  session?: string;
  turn?: string;
  events: HostCodexEvent[];
  bytes: number;
  finished: boolean;
  ownershipVerified: boolean;
  stopping: boolean;
  terminal: boolean;
  startingTurn: boolean;
  launchTask?: Promise<void>;
  ending?: Promise<void>;
  stopError?: Error;
  controlWake: Set<() => void>;
  error?: Error;
  pending?: Interaction;
  interactions: Interaction[];
  answered: Map<string, string>;
  toolCalls: Map<
    string,
    {
      call: NativeToolCall;
      signature: string;
      rpcIds: Set<string | number>;
      response?: NativeToolResponse;
    }
  >;
  steering: Map<string, { signature: string; task: Promise<HostCodexSteeringResult> }>;
  wake: Set<() => void>;
  subscribers: number;
  timer?: NodeJS.Timeout;
  usageSeen: Set<string>;
  outputPaths: Set<string>;
  outputBytes: number;
  outputs: Promise<void>;
  itemScopes: Map<
    string,
    { command?: string; cwd?: string; changes?: Array<{ path: string; diff: string }> }
  >;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const uncertain = () =>
  new Error("Native Codex turn outcome is uncertain. Check the project before starting a new run.");
/** Host-only ownership and replay boundary. Disk records contain no prompts or credentials. */
export class HostCodexBroker {
  private readonly runs = new Map<string, Run>();
  private readonly busy = new Set<string>();
  private readonly cancelled = new Map<string, number>();
  private bufferedBytes = 0;
  private readonly tasks = new Set<Promise<unknown>>();
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
  constructor(
    private readonly root: string,
    private readonly factory: CodexClientFactory = createCodexClient,
    private readonly computerRoot?: string,
    private readonly writeScopes = new NativeWriteScopes(),
  ) {}
  private key(binding: Binding) {
    return hash(JSON.stringify([binding.botId, binding.threadId, binding.runId]));
  }
  private cleanupKey(computerKey: string, runId: string) {
    return `${hash(JSON.stringify([computerKey, runId]))}.cleanup`;
  }
  private startKey(computerKey: string, runId: string) {
    return `${hash(JSON.stringify([computerKey, runId]))}.start-fence`;
  }
  private async fenceStart(computerKey: string, runId: string, state: "started" | "cancelled") {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        path.join(this.root, this.startKey(computerKey, runId)),
        JSON.stringify({ state, computerKey, runId }),
        { mode: 0o600, flag: "wx" },
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  private threadKey(input: RunInput) {
    return hash(
      JSON.stringify([
        input.botId,
        input.threadId,
        input.config.computerKey,
        input.config.historyGeneration,
        input.config.projectPath,
        input.config.permission,
        input.config.writeSubdirectory,
        ...((input.config.runtimeGeneration ?? 0) > 0 ? [input.config.runtimeGeneration] : []),
        ...(input.config.contextScope !== undefined ? ["context", input.config.contextScope] : []),
      ]),
    );
  }
  private async load(name: string): Promise<any | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.root, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async save(name: string, value: unknown) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, target);
  }
  async status(): Promise<HostCodexStatus> {
    let client: CodexClient | undefined;
    try {
      client = this.factory(
        () => undefined,
        () => undefined,
      );
      const initialized = await initializeCodex(client);
      const result = await client.request("account/read", { refreshToken: false });
      const authenticated = !!result.account || result.requiresOpenaiAuth === false;
      return {
        available: true,
        authenticated,
        ...(initialized?.nativeCapabilities
          ? { capabilities: initialized.nativeCapabilities }
          : {}),
        ...(!authenticated ? { reason: "login-required" as const } : {}),
      };
    } catch {
      return { available: false, authenticated: false, reason: "cli-unavailable" };
    } finally {
      client?.close();
    }
  }
  async models(projectPath: string): Promise<RuntimeModels> {
    if (!path.isAbsolute(projectPath) || (await realpath(projectPath)) !== projectPath)
      throw new Error("Native model settings require the canonical project directory");
    const client = this.factory(
      () => undefined,
      () => undefined,
      { cwd: projectPath },
    );
    try {
      await initializeCodex(client);
      const auth = await client.request("account/read", { refreshToken: false });
      if (!auth.account && auth.requiresOpenaiAuth !== false)
        return {
          runtimeKind: "codex",
          available: false,
          models: [],
          defaultModelId: null,
          reason: "login-required",
        };
      const catalog = await codexRuntimeModels(client);
      const config = await client.request("config/read", {
        includeLayers: false,
        cwd: projectPath,
      });
      if (!config?.config || typeof config.config !== "object")
        throw new Error("Native configuration is unavailable");
      const model =
        typeof config.config.model === "string" && config.config.model
          ? config.config.model
          : catalog.defaultModelId;
      const configuredEffort = config.config.model_reasoning_effort;
      const level = ThinkingLevelSchema.nullable().safeParse(
        configuredEffort === "none" ? "off" : (configuredEffort ?? null),
      );
      if (!level.success)
        throw new Error("Configured reasoning effort is unsupported by this application");
      return {
        ...catalog,
        defaultModelId: model,
        defaultThinkingLevel:
          level.data !== null
            ? level.data
            : (catalog.models.find((row) => row.id === model)?.defaultThinkingLevel ?? null),
      };
    } finally {
      client.close();
    }
  }
  private publish(
    run: Run,
    event: HostCodexEvent["event"],
    approvalId?: string,
    outputFile?: HostCodexEvent["outputFile"],
    toolCall?: NativeToolCall,
  ) {
    const envelope: HostCodexEvent = {
      sequence: run.events.length + 1,
      session: run.session,
      event,
      approvalId,
      outputFile,
      toolCall,
    };
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (run.bytes + bytes > 12 * 1024 * 1024 || this.bufferedBytes + bytes > 32 * 1024 * 1024) {
      void this.fail(run, new Error("Native Codex output limit exceeded")).catch(() => undefined);
      return;
    }
    run.bytes += bytes;
    this.bufferedBytes += bytes;
    run.events.push(envelope);
    for (const wake of run.wake) wake();
    run.wake.clear();
  }
  private retire(run: Run) {
    const timer = setTimeout(() => {
      this.runs.delete(this.key(run.input));
      this.bufferedBytes -= run.bytes;
    }, 10 * 60_000);
    timer.unref();
  }
  private fail(run: Run, error: Error): Promise<void> {
    if (run.finished) return run.ending ?? Promise.resolve();
    run.stopping = true;
    run.stopError ??= error;
    run.pending = undefined;
    return this.end(run);
  }
  private async clean(request: (method: string) => Promise<any>, deadline = Date.now() + 7500) {
    const call = async (method: string) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Native Codex cleanup timed out");
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          request(method),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Native Codex cleanup timed out")),
              Math.min(1500, remaining),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await call("thread/backgroundTerminals/clean");
    // clean acknowledges the request before its asynchronous process teardown has
    // removed terminals. Keep app-server alive until the registry confirms exit.
    while (true) {
      const result = await call("thread/backgroundTerminals/list");
      if (!Array.isArray(result.data))
        throw new Error("Native Codex background terminal cleanup could not be verified");
      if (!result.data.length && !result.nextCursor) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Native Codex cleanup timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  private end(run: Run): Promise<void> {
    if (run.ending) return run.ending;
    clearTimeout(run.timer);
    run.ending = (async () => {
      const deadline = Date.now() + 7500;
      const bounded = async <T>(task: Promise<T>, maximum: number): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            task,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Native Codex cleanup timed out")),
                Math.max(0, Math.min(maximum, deadline - Date.now())),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      let cleanupError: unknown;
      // File events must be buffered before done, even when the provider completes
      // immediately after its final message notification.
      try {
        await bounded(run.outputs, 1500);
      } catch {
        run.stopping = true;
        run.stopError ??= new Error("Native Codex file collection timed out");
      }
      try {
        // A pending start may still return its owned session/turn. Launch fences prevent
        // cancellation in earlier requests from ever sending a later turn/start.
        if (!run.terminal && run.launchTask)
          await bounded(
            run.launchTask.catch(() => undefined),
            2500,
          );
      } catch (error) {
        cleanupError = error;
      }
      if (!run.ownershipVerified) cleanupError ??= uncertain();
      if (run.startingTurn && !run.turn && !run.terminal) cleanupError ??= uncertain();
      if (run.session && run.client) {
        if (!run.terminal && run.turn) {
          try {
            await bounded(
              run.client.request("turn/interrupt", {
                threadId: run.session,
                turnId: run.turn,
              }),
              1500,
            );
            if (!run.terminal) {
              let wake: (() => void) | undefined;
              try {
                await bounded(
                  new Promise<void>((resolve) => {
                    wake = resolve;
                    run.controlWake.add(resolve);
                    if (run.terminal) resolve();
                  }),
                  1500,
                );
              } finally {
                if (wake) run.controlWake.delete(wake);
              }
            }
          } catch (error) {
            cleanupError ??= error;
          }
        }
        // unified_exec terminals have their own process groups. Interrupting a turn
        // and killing app-server alone does not stop these owned commands.
        try {
          await this.clean(
            (method) =>
              run.client!.request(method, {
                threadId: run.session,
              }),
            deadline,
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
      run.client?.close();
      try {
        if (cleanupError) throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
        // Acknowledged cleanup survives broker/host restarts. Absence of an
        // in-memory process is never sufficient evidence for deliberate recovery.
        await this.save(this.cleanupKey(run.input.config.computerKey, run.input.runId), {
          state: "cleaned",
          computerKey: run.input.config.computerKey,
          runId: run.input.runId,
        });
        if (run.stopError) throw run.stopError;
        await this.save(`${this.key(run.input)}.run`, {
          state: "completed",
          computerKey: run.input.config.computerKey,
          runId: run.input.runId,
          session: run.session,
          threadKey: this.threadKey(run.input),
        });
        if (run.stopError) throw run.stopError;
        await run.releaseWriteScope?.();
        run.releaseWriteScope = undefined;
        this.busy.delete(this.threadKey(run.input));
        this.publish(run, { type: "done" });
        if (run.stopError) throw run.stopError;
      } catch (error) {
        run.error = error instanceof Error ? error : uncertain();
      } finally {
        if (!cleanupError && run.releaseWriteScope) {
          try {
            await run.releaseWriteScope();
          } catch (error) {
            run.error = error instanceof Error ? error : uncertain();
          }
        }
        if (!cleanupError) this.busy.delete(this.threadKey(run.input));
        run.finished = true;
        for (const wake of run.wake) wake();
        run.wake.clear();
        this.retire(run);
      }
      if (cleanupError) throw run.error;
    })();
    this.track(run.ending);
    return run.ending;
  }
  private armOrphan(run: Run) {
    clearTimeout(run.timer);
    if (run.finished || run.stopping || run.ending || run.subscribers) return;
    run.timer = setTimeout(
      () =>
        void this.fail(run, new Error("Native Codex supervision expired")).catch(() => undefined),
      run.pending || [...run.toolCalls.values()].some((call) => !call.response)
        ? 30 * 60_000
        : 2 * 60_000,
    );
    run.timer.unref();
  }
  private message(run: Run, message: CodexMessage) {
    if (run.finished) return;
    const p = message.params ?? {};
    if (message.method === "turn/started" || message.method === "turn/completed") {
      if (!run.startingTurn && !run.turn) return;
      if (p.threadId !== run.session || typeof p.turn?.id !== "string") return;
      if (run.turn && p.turn.id !== run.turn) return;
      if (p.turnId && p.turnId !== p.turn.id) return;
      run.turn = p.turn.id;
      if (message.method === "turn/completed") {
        run.terminal = true;
        for (const wake of run.controlWake) wake();
        run.controlWake.clear();
        if (!run.stopping) {
          if (p.turn.status === "completed") this.end(run);
          else
            this.fail(
              run,
              new Error(
                p.failureCode === "authentication_failed"
                  ? "Sign in to the native runtime on the host before starting this bot"
                  : "Native Codex turn failed or was interrupted",
              ),
            );
        }
      }
      return;
    }
    if (run.stopping || run.ending) return;
    if (message.method && message.id !== undefined) {
      if (p.threadId !== run.session || (run.turn && p.turnId !== run.turn)) {
        this.fail(run, new Error("Native Codex request binding mismatch"));
        return;
      }
      if (message.method === "item/tool/call") {
        if (
          typeof p.callId !== "string" ||
          !p.callId ||
          p.callId.length > 256 ||
          typeof p.turnId !== "string" ||
          (!run.turn && !run.startingTurn) ||
          p.namespace != null ||
          !run.input.tools?.some((tool) => tool.name === p.tool) ||
          !p.arguments ||
          typeof p.arguments !== "object" ||
          Array.isArray(p.arguments)
        ) {
          void this.fail(run, new Error("Native application tool binding mismatch"));
          return;
        }
        run.turn ??= p.turnId;
        const signature = hash(JSON.stringify([p.tool, p.arguments]));
        const previous = run.toolCalls.get(p.callId);
        if (previous) {
          if (previous.signature !== signature) {
            void this.fail(run, new Error("Native application tool call changed"));
            return;
          }
          previous.rpcIds.add(message.id);
          if (previous.response) run.client!.reply(message.id, previous.response);
          return;
        }
        if (run.toolCalls.size >= 256) {
          void this.fail(run, new Error("Native application tool call limit exceeded"));
          return;
        }
        const call: NativeToolCall = {
          callId: p.callId,
          tool: p.tool,
          arguments: p.arguments,
          executionId: JSON.stringify(["native-tool", run.input.runId, p.callId]),
        };
        run.toolCalls.set(p.callId, { call, signature, rpcIds: new Set([message.id]) });
        this.publish(
          run,
          { type: "progress", text: "Using an application tool", activity: true },
          undefined,
          undefined,
          call,
        );
        this.armOrphan(run);
        return;
      }
      const approval =
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval";
      const question = message.method === "item/tool/requestUserInput";
      if (!approval && !question) {
        this.fail(run, new Error("Native Codex requested an unsupported interaction"));
        return;
      }
      if (
        question &&
        (!Array.isArray(p.questions) ||
          !p.questions.length ||
          p.questions.length > 20 ||
          p.questions.some(
            (q: Question) => !q || typeof q.id !== "string" || typeof q.question !== "string",
          ) ||
          new Set(p.questions.map((q: Question) => q.id)).size !== p.questions.length)
      ) {
        this.fail(run, new Error("Native Codex returned invalid questions"));
        return;
      }
      if (question && p.questions.some((q: Question) => q.isSecret)) {
        this.fail(run, new Error("Native Codex secret input requires local sign-in"));
        return;
      }
      if (run.interactions.length >= 20) {
        this.fail(run, new Error("Native Codex interaction limit exceeded"));
        return;
      }
      let detail: string | undefined;
      if (approval) {
        // Scoped tasks cannot gain broader OS permissions through an approval.
        if (run.input.config.writeSubdirectory) {
          run.client!.reply(message.id, { decision: "decline" });
          return;
        }
        const scope = run.itemScopes.get(p.itemId);
        if (message.method === "item/commandExecution/requestApproval") {
          const command = p.command ?? scope?.command;
          const cwd = p.cwd ?? scope?.cwd;
          const network = p.networkApprovalContext;
          if (
            typeof command === "string" &&
            command.length > 0 &&
            command.length <= 16_384 &&
            typeof cwd === "string" &&
            cwd.length <= 4096
          )
            detail = `Working directory: ${cwd}\nCommand: ${command}`;
          else if (typeof network?.host === "string" && network.host.length <= 4096)
            detail = `Network: ${network.protocol ?? "network"} ${network.host}`;
        } else if (scope?.changes?.length) {
          const paths = scope.changes.map((change) => change.path).join("\n");
          if (paths.length <= 16_384) {
            const diffs = scope.changes
              .map((change) => `${change.path}\n${change.diff}`)
              .join("\n\n");
            detail = `${p.grantRoot ? `Requested write root: ${String(p.grantRoot).slice(0, 4096)}\n` : ""}Files:\n${paths}\n\nDiffs:\n${diffs.slice(0, 32_768)}${diffs.length > 32_768 ? "\n[Diff truncated]" : ""}`;
          }
        }
        if (!detail) {
          this.fail(run, new Error("Native Codex approval scope is unavailable"));
          return;
        }
        if (typeof p.reason === "string") detail += `\nReason: ${p.reason.slice(0, 2048)}`;
      }
      const id = randomUUID();
      const interaction: Interaction = {
        id,
        rpcId: message.id,
        kind: question ? "question" : "approval",
        questions: p.questions,
        index: 0,
        answers: Object.create(null),
        detail,
      };
      if (run.pending) run.interactions.push(interaction);
      else this.ask(run, interaction);
      this.armOrphan(run);
      return;
    }
    if (p.threadId && p.threadId !== run.session) return;
    if (run.turn && p.turnId && p.turnId !== run.turn) return;
    if (message.method === "item/agentMessage/delta") {
      if (typeof p.delta === "string") this.publish(run, { type: "text", text: p.delta });
    } else if (message.method === "item/started") {
      const item = p.item;
      if (item?.id && (item.type === "commandExecution" || item.type === "fileChange")) {
        const changes =
          item.type === "fileChange" &&
          Array.isArray(item.changes) &&
          item.changes.length <= 100 &&
          item.changes.every(
            (change: any) =>
              typeof change.path === "string" &&
              change.path.length <= 4096 &&
              typeof change.diff === "string",
          )
            ? item.changes.map((change: any) => ({
                path: change.path,
                diff:
                  change.diff.slice(0, 4096) +
                  (change.diff.length > 4096 ? "\n[Diff truncated]" : ""),
              }))
            : undefined;
        run.itemScopes.set(item.id, { command: item.command, cwd: item.cwd, changes });
        if (run.itemScopes.size > 128) run.itemScopes.delete(run.itemScopes.keys().next().value!);
      }
      if (item?.type === "commandExecution" || item?.type === "fileChange")
        this.publish(run, {
          type: "progress",
          text: item.type === "commandExecution" ? "Running a command" : "Editing files",
          activity: true,
        });
    } else if (message.method === "item/completed") {
      const item = p.item;
      if (item?.type === "imageGeneration" && typeof item.savedPath === "string")
        this.output(run, item.savedPath);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        // Only explicit Markdown links declare a deliverable. Never scan the project
        // or upload unrelated files the agent happened to edit.
        for (const match of item.text.matchAll(
          /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g,
        )) {
          this.output(run, match[1] ?? match[2]!);
        }
      }
    } else if (message.method === "thread/tokenUsage/updated") {
      const u = p.tokenUsage?.last;
      // `last` describes one model call, while `total` identifies its position in the
      // native transcript. Only this owned turn contributes usage; resumed history does not.
      if (u && run.turn && p.turnId === run.turn && p.tokenUsage?.total) {
        const signature = hash(JSON.stringify(p.tokenUsage.total));
        if (run.usageSeen.has(signature)) return;
        run.usageSeen.add(signature);
        const tokens = (key: string) =>
          typeof u[key] === "number" && Number.isFinite(u[key]) && u[key] >= 0 ? u[key] : null;
        const input = tokens("inputTokens"),
          cached = tokens("cachedInputTokens");
        this.publish(run, {
          type: "usage",
          callId: `${run.input.runId}:${signature}`,
          provider: p.nativeProvider ?? "openai-codex",
          model: run.input.model,
          inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
          outputTokens: tokens("outputTokens"),
          cacheReadTokens: cached,
          cacheWriteTokens: tokens("cacheWriteInputTokens"),
          reasoningTokens: tokens("reasoningOutputTokens"),
          totalTokens: tokens("totalTokens"),
          costUsd: null,
          usageSource: p.usageSource ?? "codex-app-server",
        });
      }
    }
  }
  private output(run: Run, link: string) {
    let filePath: string;
    try {
      filePath = decodeURIComponent(link.replace(/^sandbox:/, ""));
    } catch {
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(filePath) || filePath.includes("\0")) return;
    const target = path.resolve(run.input.config.projectPath, filePath);
    const relative = path.relative(run.input.config.projectPath, target);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      !inferAttachmentMimeType(target) ||
      run.outputPaths.has(target) ||
      run.outputPaths.size >= 10
    )
      return;
    run.outputPaths.add(target);
    run.outputs = run.outputs.then(async () => {
      if (run.stopping || run.finished) return;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const project = run.input.config.projectPath;
        if ((await realpath(project)) !== project || (await realpath(target)) !== target) return;
        handle = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const owned = await handle.stat();
        if (!owned.isFile() || owned.size > 8 * 1024 * 1024 - run.outputBytes) return;
        const current = await stat(target);
        if (
          owned.ino !== current.ino ||
          owned.dev !== current.dev ||
          (await realpath(target)) !== target ||
          (await realpath(project)) !== project
        )
          return;
        // Read at most one byte beyond the budget; growing files cannot force an
        // unbounded allocation after the size check.
        const data = Buffer.alloc(owned.size + 1);
        const read = await handle.read(data, 0, data.length, 0);
        if (read.bytesRead !== owned.size) return;
        const after = await stat(target);
        if (
          owned.ino !== after.ino ||
          owned.dev !== after.dev ||
          after.size !== owned.size ||
          after.mtimeMs !== owned.mtimeMs ||
          (await realpath(target)) !== target ||
          (await realpath(project)) !== project
        )
          return;
        if (run.stopping || run.finished) return;
        const bytes = data.subarray(0, read.bytesRead);
        run.outputBytes += bytes.length;
        this.publish(run, { type: "progress", text: "Created a file", activity: true }, undefined, {
          id: hash(JSON.stringify([run.input.runId, relative, hash(bytes.toString("base64"))])),
          path: relative,
          content: bytes.toString("base64"),
        });
      } catch {
        /* Nonexistent, unsupported, or unsafe links remain ordinary text. */
      } finally {
        await handle?.close().catch(() => undefined);
      }
    });
  }
  private ask(run: Run, interaction: Interaction) {
    run.pending = interaction;
    const question = interaction.questions?.[interaction.index];
    this.publish(
      run,
      {
        type: "ask",
        ...(interaction.kind === "approval" ? { nativeApproval: true } : {}),
        executionId: interaction.id,
        text: question?.question ?? "Allow this action?",
        detail:
          interaction.detail ??
          question?.options
            ?.filter((option) => option.description)
            .map((option) => `${option.label}: ${option.description}`)
            .join("\n"),
        actions:
          interaction.kind === "approval"
            ? [
                { id: "approve", label: "Approve" },
                { id: "reject", label: "Reject" },
              ]
            : question?.options?.map((option) => ({ id: option.label, label: option.label })),
      },
      interaction.id,
    );
  }
  private async launch(run: Run) {
    if (run.stopping || run.finished) return;
    const input = run.input;
    if (
      input.config.writeSubdirectory &&
      (input.config.permission !== "workspace" ||
        (input.nativeKind && input.nativeKind !== "codex") ||
        input.tools?.length)
    )
      throw new Error("Scoped tasks require Codex Workspace without application tools");
    run.writeRoot = await canonicalWriteScope(
      input.config.projectPath,
      input.config.writeSubdirectory,
      false,
    );
    if (
      input.config.writeSubdirectory &&
      (scopesOverlap(run.writeRoot, this.root) ||
        (this.computerRoot && scopesOverlap(run.writeRoot, this.computerRoot)))
    )
      throw new Error("Task write scope overlaps private native state");
    run.releaseWriteScope = await this.writeScopes.acquire(
      `${this.root}:${this.key(input)}`,
      input.config.writeSubdirectory ? run.writeRoot : null,
      () => run.stopping || run.finished,
      input.config.applicationRunId ?? input.runId,
    );
    // Verify aliases only after acquiring ownership: an earlier unconfined writer
    // could otherwise replace files while this task waits for its scope.
    await canonicalWriteScope(input.config.projectPath, input.config.writeSubdirectory);
    if ((await realpath(input.config.projectPath)) !== input.config.projectPath)
      throw new Error("Native Codex requires a canonical absolute project directory");
    if (run.stopping) return;
    if (!(await stat(input.config.projectPath)).isDirectory())
      throw new Error("Native Codex project must be a directory");
    if (run.stopping) return;
    run.client = this.factory(
      (message) => this.message(run, message),
      () => {
        if (!run.ending) this.fail(run, uncertain());
      },
      { cwd: run.writeRoot },
    );
    await initializeCodex(run.client);
    if (run.stopping) return;
    const auth = await run.client.request("account/read", { refreshToken: false });
    if (run.stopping) return;
    if (!auth.account && auth.requiresOpenaiAuth !== false)
      throw new Error("Sign in to Codex on the host before starting this bot");
    let selectedEffort = input.thinkingLevel ?? null;
    if (input.model !== "default" && input.thinkingLevel !== undefined) {
      const catalog = await codexRuntimeModels(run.client);
      const selected = catalog.models.find((model) => model.id === input.model);
      if (!selected) throw new Error("That model is unavailable on this host");
      if (selectedEffort !== null && !selected.thinkingLevels.includes(selectedEffort))
        throw new Error("That reasoning effort is unavailable for this model");
      if (
        selectedEffort === null &&
        selected.defaultThinkingLevel === null &&
        selected.thinkingLevels.length > 0
      )
        throw new Error("Choose an explicit reasoning effort for this model");
      selectedEffort ??= selected.defaultThinkingLevel;
    }
    const hostConfig = await run.client.request("config/read", {
      includeLayers: false,
      cwd: run.writeRoot,
    });
    const threadConfig = await nativeCodexThreadConfig(run.client, run.writeRoot, hostConfig);
    const defaultModel = hostConfig.config.model ?? null;
    const defaultEffort = hostConfig.config.model_reasoning_effort ?? null;
    const sessionKey = `${this.threadKey(input)}.session`;
    const previous = await this.load(sessionKey);
    // Dynamic tools are fixed at thread/start; resume cannot update a catalog.
    let stored =
      (previous?.toolCatalogFingerprint ?? "") === (input.toolCatalogFingerprint ?? "")
        ? previous
        : undefined;
    // A resumed thread may retain its previous turn's model/effort overrides.
    // Start from host defaults whenever the saved preference changes; the app
    // supplies the authorized conversation history to the fresh session below.
    if (
      stored &&
      ((stored.model ?? "default") !== input.model ||
        (stored.thinkingLevel ?? null) !== (input.thinkingLevel ?? null))
    )
      stored = undefined;
    if (
      stored &&
      input.model === "default" &&
      ((stored.defaultModel ?? null) !== defaultModel ||
        (stored.defaultEffort ?? null) !== defaultEffort)
    )
      stored = undefined;
    if (auth.canResume === false) stored = undefined;
    // Legacy records have no authorization scope and may only serve legacy callers.
    if (stored?.contextScope !== input.config.contextScope) stored = undefined;
    if (run.stopping) return;
    const account = hash(
      JSON.stringify(
        auth.account?.type === "chatgpt"
          ? { type: "chatgpt", email: auth.account.email }
          : (auth.account ?? { external: auth.requiresOpenaiAuth === false }),
      ),
    );
    if (stored && stored.account !== account) stored = undefined;
    if (input.session && input.session !== stored?.session)
      throw new Error("Native session does not belong to this bot and project");
    const config = {
      cwd: run.writeRoot,
      model: input.model && input.model !== "default" ? input.model : null,
      approvalPolicy: input.config.writeSubdirectory ? "never" : "on-request",
      approvalsReviewer: "user",
      sandbox: input.config.permission === "workspace" ? "workspace-write" : "danger-full-access",
      developerInstructions: [
        input.instructions,
        this.computerRoot
          ? `Chat attachment paths are relative to ${path.join(this.computerRoot, hash(input.config.computerKey))}. Read attached files there; keep project work in the configured project.`
          : undefined,
        "Link produced deliverables using Markdown file links to paths within the configured project so they can be attached to the conversation. Up to 10 files and 8 MiB total can be attached.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      config: threadConfig,
    };
    if (run.stopping) return;
    const result = await run.client.request(stored?.session ? "thread/resume" : "thread/start", {
      ...config,
      ...(stored?.session ? { threadId: stored.session } : {}),
      ...(!stored?.session || (input.nativeKind && input.nativeKind !== "codex")
        ? { dynamicTools: (input.tools ?? []).map((tool) => ({ type: "function", ...tool })) }
        : {}),
    });
    run.session = result.thread?.id;
    if (!run.session) throw new Error("Native Codex returned no session");
    if (run.stopping) return;
    // Fail closed before any work on CLIs that cannot clean independently owned terminals.
    await this.clean((method) => run.client!.request(method, { threadId: run.session }));
    if (run.stopping) return;
    await this.save(sessionKey, {
      session: run.session,
      account,
      toolCatalogFingerprint: input.toolCatalogFingerprint,
      contextScope: input.config.contextScope,
      model: input.model,
      thinkingLevel: input.thinkingLevel ?? null,
      defaultModel,
      defaultEffort,
    });
    if (run.stopping) return;
    this.publish(run, {
      type: "progress",
      text: `${input.nativeKind === "claude" ? "Claude Code" : input.nativeKind === "acp" ? "ACP" : "Codex"} is working`,
      activity: true,
    });
    // Fence before turn/start: a lost start response never authorizes another start.
    await this.save(`${this.key(input)}.run`, {
      state: "started",
      computerKey: input.config.computerKey,
      runId: input.runId,
      session: run.session,
      threadKey: this.threadKey(input),
    });
    if (run.stopping || run.finished) return;
    run.startingTurn = true;
    const turn = await run.client.request("turn/start", {
      threadId: run.session,
      model: input.model && input.model !== "default" ? input.model : null,
      effort: selectedEffort === "off" ? "none" : selectedEffort,
      input: [
        {
          type: "text",
          text:
            !stored && input.history
              ? `Conversation context:\n${input.history}\n\nCurrent request:\n${input.prompt}`
              : input.prompt,
          text_elements: [],
        },
        ...(input.images ?? []).map((url) => ({ type: "image", url })),
        ...(input.imageFallback
          ? [{ type: "text", text: input.imageFallback, text_elements: [] }]
          : []),
      ],
      cwd: run.writeRoot,
      approvalPolicy: input.config.writeSubdirectory ? "never" : "on-request",
      approvalsReviewer: "user",
      sandboxPolicy:
        input.config.permission === "workspace"
          ? {
              type: "workspaceWrite",
              writableRoots: [run.writeRoot],
              networkAccess: true,
              excludeTmpdirEnvVar: !!input.config.writeSubdirectory,
              excludeSlashTmp: !!input.config.writeSubdirectory,
            }
          : { type: "dangerFullAccess" },
    });
    if (run.turn && turn.turn?.id && run.turn !== turn.turn.id) throw uncertain();
    run.turn = turn.turn?.id ?? run.turn;
    if (!run.turn) throw uncertain();
  }
  async *run(input: RunInput, signal: AbortSignal): AsyncIterable<HostCodexEvent> {
    if (
      input.config.applicationRunId &&
      input.runId !== nativeIntroExecutionId(input.config.applicationRunId)
    )
      throw new Error("Native application owner binding mismatch");
    if (!path.isAbsolute(input.config.projectPath))
      throw new Error("Native Codex requires a canonical absolute project directory");
    signal.throwIfAborted();
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Native Codex process supervision is unsupported on this host");
    const key = this.key(input);
    if ((this.cancelled.get(key) ?? 0) > Date.now()) throw new Error("Native Codex stopped");
    let run = this.runs.get(key);
    if (
      run &&
      JSON.stringify([
        run.input.config,
        run.input.prompt,
        run.input.images,
        run.input.imageFallback,
        run.input.instructions,
        run.input.model,
        run.input.thinkingLevel,
        run.input.tools,
        run.input.toolCatalogFingerprint,
      ]) !==
        JSON.stringify([
          input.config,
          input.prompt,
          input.images,
          input.imageFallback,
          input.instructions,
          input.model,
          input.thinkingLevel,
          input.tools,
          input.toolCatalogFingerprint,
        ])
    )
      throw new Error("Native run binding mismatch");
    if (!run) {
      if (this.runs.size >= 64) throw new Error("Native Codex supervision capacity reached");
      if (this.busy.has(this.threadKey(input)))
        throw new Error("Native conversation is already running");
      this.busy.add(this.threadKey(input));
      run = {
        input,
        events: [],
        bytes: 0,
        finished: false,
        ownershipVerified: false,
        stopping: false,
        terminal: false,
        startingTurn: false,
        controlWake: new Set(),
        answered: new Map(),
        toolCalls: new Map(),
        steering: new Map(),
        interactions: [],
        usageSeen: new Set(),
        outputPaths: new Set(),
        outputBytes: 0,
        outputs: Promise.resolve(),
        itemScopes: new Map(),
        wake: new Set(),
        subscribers: 0,
      };
      this.runs.set(key, run);
      const owned = run;
      owned.launchTask = (async () => {
        const startFence = await this.load(this.startKey(input.config.computerKey, input.runId));
        if (
          startFence?.state === "cancelled" &&
          startFence.computerKey === input.config.computerKey &&
          startFence.runId === input.runId
        ) {
          owned.ownershipVerified = true;
          throw new Error("Native Codex stopped before launch");
        }
        if (await this.load(this.cleanupKey(input.config.computerKey, input.runId)))
          throw uncertain();
        if (await this.load(`${key}.run`)) throw uncertain();
        if (!(await this.fenceStart(input.config.computerKey, input.runId, "started")))
          throw uncertain();
        owned.ownershipVerified = true;
        await this.launch(owned);
      })();
      this.track(
        owned.launchTask.catch((error) =>
          this.fail(owned, error instanceof Error ? error : uncertain()),
        ),
      );
    }
    run.subscribers++;
    clearTimeout(run.timer);
    let cursor = input.after;
    try {
      while (true) {
        signal.throwIfAborted();
        while (cursor < run.events.length) yield run.events[cursor++]!;
        if (run.error) throw run.error;
        if (run.finished) return;
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            run!.wake.delete(wake);
            resolve();
          };
          run!.wake.add(wake);
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted) wake();
        });
      }
    } finally {
      run.subscribers--;
      this.armOrphan(run);
    }
  }
  toolResult(binding: Binding, callId: string, response: NativeToolResponse) {
    const run = this.runs.get(this.key(binding));
    if (!run || run.stopping) throw new Error("Native application tool is no longer available");
    const pending = run.toolCalls.get(callId);
    if (!pending) throw new Error("Native application tool result binding mismatch");
    if (pending.response) {
      if (JSON.stringify(pending.response) !== JSON.stringify(response))
        throw new Error("Native application tool already answered");
      // A completed turn can acknowledge an already accepted result too. If the
      // first write failed before delivery, retry it while the process is live.
      if (!run.finished && !run.ending)
        for (const id of pending.rpcIds) run.client!.reply(id, response);
      return;
    }
    if (run.finished || run.ending)
      throw new Error("Native application tool is no longer available");
    // Set before writing: a lost transport acknowledgement may safely resend this result.
    pending.response = response;
    for (const id of pending.rpcIds) run.client!.reply(id, response);
    this.armOrphan(run);
  }
  answer(binding: Binding, approvalId: string, answer: string) {
    const run = this.runs.get(this.key(binding));
    if (!run || run.finished || run.stopping || run.ending)
      throw new Error("Native approval is no longer available");
    const answered = run.answered.get(approvalId);
    if (answered !== undefined) {
      if (answered !== answer) throw new Error("Native approval already answered");
      return;
    }
    const pending = run.pending;
    if (!pending || pending.id !== approvalId) throw new Error("Native approval binding mismatch");
    if (pending.kind === "approval" && answer !== "approve" && answer !== "reject")
      throw new Error("Choose approve or reject");
    run.answered.set(approvalId, answer);
    run.pending = undefined;
    if (pending.kind === "question") {
      pending.answers[pending.questions![pending.index]!.id] = { answers: [answer] };
      pending.index++;
      if (pending.index < pending.questions!.length) {
        pending.id = randomUUID();
        this.ask(run, pending);
        this.armOrphan(run);
        return;
      }
    }
    run.client!.reply(
      pending.rpcId,
      pending.kind === "approval"
        ? { decision: answer === "approve" ? "accept" : "decline" }
        : { answers: pending.answers },
    );
    const next = run.interactions.shift();
    if (next) this.ask(run, next);
    this.armOrphan(run);
  }
  async steer(
    input: Extract<HostComputerRequest, { method: "codexSteer" }>,
  ): Promise<HostCodexSteeringResult> {
    const run = this.runs.get(this.key(input));
    if (!run) return { accepted: false, reason: "turn-ended" };
    const signature = hash(JSON.stringify([input.text, input.images, input.imageFallback]));
    const previous = run.steering.get(input.messageId);
    if (previous) {
      if (previous.signature !== signature) throw new Error("Native steering binding mismatch");
      return previous.task;
    }
    const task = (async (): Promise<HostCodexSteeringResult> => {
      await run.launchTask;
      if (run.finished || run.stopping || run.ending || run.terminal || !run.turn || !run.client)
        return { accepted: false, reason: "turn-ended" };
      const result = await run.client.request("turn/steer", {
        threadId: run.session,
        expectedTurnId: run.turn,
        clientUserMessageId: input.messageId,
        input: [
          { type: "text", text: input.text, text_elements: [] },
          ...(input.images ?? []).map((url) => ({ type: "image", url })),
          ...(input.imageFallback
            ? [{ type: "text", text: input.imageFallback, text_elements: [] }]
            : []),
        ],
      });
      if (result.turnId !== run.turn) throw uncertain();
      return { accepted: true };
    })().catch(async (error): Promise<HostCodexSteeringResult> => {
      // Only a received RPC rejection proves it did not submit. A lost response
      // stays uncertain even when completion arrives while the RPC is pending.
      if (error instanceof CodexRpcError && run.terminal && !run.stopping)
        return { accepted: false, reason: "turn-ended" };
      await this.fail(run, error instanceof Error ? error : uncertain()).catch(() => undefined);
      throw error;
    });
    run.steering.set(input.messageId, { signature, task });
    return task;
  }
  async abort(binding: Binding) {
    const key = this.key(binding);
    this.cancelled.delete(key);
    this.cancelled.set(key, Date.now() + 10 * 60_000);
    if (this.cancelled.size > 256) this.cancelled.delete(this.cancelled.keys().next().value!);
    const run = this.runs.get(key);
    if (run) await this.fail(run, new Error("Native Codex stopped"));
  }
  /** Retire a provider turn without fencing the still-live application run's tools. */
  async retireRun(binding: Binding, computerKey: string) {
    const run = this.runs.get(this.key(binding));
    if (run && run.input.config.computerKey !== computerKey)
      throw new Error("Native retirement binding mismatch");
    await this.stopBot(computerKey, binding.runId, true);
  }
  async stopBot(botId: string, runId?: string, requireCleanup = false) {
    const stops: Promise<void>[] = [];
    for (const run of this.runs.values())
      if (run.input.config.computerKey === botId && (!runId || run.input.runId === runId))
        stops.push(this.fail(run, new Error("Native Codex stopped")));
    const results = await Promise.allSettled(stops);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (requireCleanup) {
      if (!runId) throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
      let receipt = await this.load(this.cleanupKey(botId, runId));
      if (!receipt && !stops.length) {
        // Old releases journaled a turn without its computer/run identity. An
        // unresolved legacy record cannot prove that a missing new fence is safe.
        let names: string[] = [];
        try {
          names = await readdir(this.root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const name of names.filter((name) => name.endsWith(".run"))) {
          const journal = await this.load(name);
          if (
            journal?.state !== "completed" &&
            (!journal?.computerKey || (journal.computerKey === botId && journal.runId === runId))
          ) {
            const late =
              journal.computerKey === botId && journal.runId === runId
                ? [...this.runs.values()].find(
                    (run) => run.input.config.computerKey === botId && run.input.runId === runId,
                  )
                : undefined;
            if (!late) throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
            await this.fail(late, new Error("Native Codex stopped"));
            receipt = await this.load(this.cleanupKey(botId, runId));
            if (receipt?.state !== "cleaned") throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
          }
        }
        const created = await this.fenceStart(botId, runId, "cancelled");
        const fence = created ? undefined : await this.load(this.startKey(botId, runId));
        const late = [...this.runs.values()].find(
          (run) => run.input.config.computerKey === botId && run.input.runId === runId,
        );
        if (late) {
          await this.fail(late, new Error("Native Codex stopped"));
          receipt = await this.load(this.cleanupKey(botId, runId));
        }
        if (
          created ||
          (fence?.state === "cancelled" && fence.computerKey === botId && fence.runId === runId)
        ) {
          await this.save(this.cleanupKey(botId, runId), {
            state: "cleaned",
            computerKey: botId,
            runId,
          });
          receipt = await this.load(this.cleanupKey(botId, runId));
        }
      }
      if (receipt?.state !== "cleaned" || receipt.computerKey !== botId || receipt.runId !== runId)
        throw new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE);
    }
  }
  async close() {
    const stops = [...this.runs.values()].map((run) =>
      this.fail(run, new Error("Local computer access revoked")),
    );
    const results = await Promise.allSettled(stops);
    let timer: NodeJS.Timeout | undefined;
    try {
      // Real requests reject on close. A nonresponsive transport must not hold
      // revocation forever; any later resolution still encounters launch fences.
      await Promise.race([
        Promise.allSettled([...this.tasks]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
