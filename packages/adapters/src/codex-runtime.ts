import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import type { RuntimeModels } from "@rakazo/contracts";
import { RuntimeModelsSchema, ThinkingLevelSchema } from "@rakazo/contracts";
import type {
  HostCodexEvent,
  HostCodexStatus,
  HostCodexSteeringResult,
  NativeCodexCheckpoint,
} from "./host-codex-protocol.js";
import { CODEX_INLINE_IMAGE_MAX_BYTES } from "./host-codex-protocol.js";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { HOST_COMPUTER_MAX_BYTES } from "./host-computer-protocol.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import {
  buildNativeHistory,
  nativeCheckpointBelongsToRun,
  nativeIntroExecutionId,
} from "./native-context.js";
import { NativeToolBridge } from "./native-tool-bridge.js";

export class NativeIntroHandoverError extends Error {}

export interface CodexTransport {
  request<T>(request: HostComputerRequest, context: AdapterContext): AsyncIterable<T>;
}
/** Reuses the host credential boundary; no provider credential crosses the bridge. */
export class HostCodexTransport extends HostComputerSandbox implements CodexTransport {}

type Checkpoint = NativeCodexCheckpoint & {
  prompt: string;
  images?: string[];
  imageFallback?: string;
  steeringIds?: string[];
  instructions: string;
  model: string;
  history?: string;
};
function fitInlineImages(
  images: AgentRunRequest["currentTurnImages"],
  input: Record<string, unknown>,
) {
  const selected: Array<{ name: string; url: string }> = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const image of images ?? []) {
    if (selected.length >= 10 || bytes + image.data.byteLength > CODEX_INLINE_IMAGE_MAX_BYTES) {
      omitted.push(image.name);
      continue;
    }
    bytes += image.data.byteLength;
    selected.push({
      name: image.name,
      url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
    });
  }
  const fallback = () =>
    omitted.length
      ? `Additional images are available as materialized attachments. Inspect their attachment paths from the user context with native image tools: ${omitted
          .map((name) => JSON.stringify(name))
          .join(", ")
          .slice(0, 7900)}`
      : undefined;
  while (
    selected.length &&
    Buffer.byteLength(
      JSON.stringify({
        ...input,
        images: selected.map((image) => image.url),
        imageFallback: fallback(),
      }),
    ) >
      HOST_COMPUTER_MAX_BYTES - 1024
  )
    omitted.push(selected.pop()!.name);
  return { images: selected.map((image) => image.url), imageFallback: fallback() };
}
type ActiveRun = {
  binding: { botId: string; threadId: string; runId: string };
  context: AdapterContext;
  aborting?: Promise<void>;
};
export function readCodexCheckpoint(blob: string): Checkpoint {
  let value: Checkpoint;
  try {
    value = JSON.parse(blob);
  } catch {
    throw new Error("Invalid native Codex checkpoint");
  }
  if (
    !["codex", "claude", "acp"].includes(value.runtime) ||
    value.version !== 1 ||
    !value.botId ||
    !value.threadId ||
    !value.runId ||
    !Number.isSafeInteger(value.after) ||
    value.after < 0 ||
    typeof value.prompt !== "string" ||
    typeof value.instructions !== "string" ||
    (value.images !== undefined &&
      (!Array.isArray(value.images) || value.images.some((image) => typeof image !== "string"))) ||
    (value.steeringIds !== undefined &&
      (!Array.isArray(value.steeringIds) ||
        value.steeringIds.some((id) => typeof id !== "string"))) ||
    (value.pendingToolCall !== undefined &&
      (typeof value.pendingToolCall.callId !== "string" ||
        !value.pendingToolCall.callId ||
        typeof value.pendingToolCall.tool !== "string" ||
        typeof value.pendingToolCall.executionId !== "string" ||
        !value.pendingToolCall.arguments ||
        typeof value.pendingToolCall.arguments !== "object" ||
        Array.isArray(value.pendingToolCall.arguments))) ||
    (value.introHandover !== undefined &&
      (typeof value.introHandover.applicationRunId !== "string" ||
        !value.introHandover.applicationRunId ||
        !["stopping", "ready"].includes(value.introHandover.phase) ||
        typeof value.introHandover.answer !== "string" ||
        !value.introHandover.answer.trim() ||
        !nativeCheckpointBelongsToRun(value, value.introHandover.applicationRunId))) ||
    typeof value.model !== "string" ||
    (value.thinkingLevel !== undefined &&
      value.thinkingLevel !== null &&
      !ThinkingLevelSchema.safeParse(value.thinkingLevel).success) ||
    typeof value.projectPath !== "string" ||
    typeof value.computerKey !== "string" ||
    !value.computerKey ||
    !Number.isSafeInteger(value.historyGeneration) ||
    value.historyGeneration < 0 ||
    (value.runtimeGeneration !== undefined &&
      (!Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 0)) ||
    (value.contextScope !== undefined &&
      (typeof value.contextScope !== "string" ||
        !value.contextScope ||
        value.contextScope.length > 256)) ||
    !["workspace", "full"].includes(value.permission)
  )
    throw new Error("Invalid native Codex checkpoint");
  return value;
}

export class CodexAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly transport: CodexTransport;
  constructor(
    transport: CodexTransport,
    private readonly nativeKind: "codex" | "claude" | "acp" = "codex",
  ) {
    this.transport = {
      request: <T>(request: HostComputerRequest, context: AdapterContext) =>
        transport.request<T>(
          request.method.startsWith("codex") && nativeKind !== "codex"
            ? ({ ...request, nativeKind } as HostComputerRequest)
            : request,
          context,
        ),
    };
  }
  describe() {
    return {
      id: this.nativeKind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: true,
        scripted: false,
        ...(this.nativeKind === "codex" ? { images: true } : {}),
      },
    };
  }
  async status(
    botId: string,
    threadId: string,
    runId: string,
    context: AdapterContext,
  ): Promise<HostCodexStatus> {
    for await (const status of this.transport.request<HostCodexStatus>(
      { method: "codexStatus", botId, threadId, runId },
      context,
    ))
      return status;
    throw new Error("Local Codex status unavailable");
  }
  async abort(runId: string) {
    const active = this.active.get(runId);
    if (!active) return;
    await this.abortOwned(runId, active);
  }
  async models(
    botId: string,
    threadId: string,
    projectPath: string,
    context: AdapterContext,
  ): Promise<RuntimeModels> {
    for await (const value of this.transport.request<RuntimeModels>(
      { method: "codexModels", botId, threadId, projectPath, runId: context.operationId },
      context,
    ))
      return RuntimeModelsSchema.parse(value);
    throw new Error("Native model catalog is unavailable");
  }
  private async abortOwned(runId: string, active: ActiveRun) {
    if (this.active.get(runId) !== active) return;
    active.aborting ??= this.abortBinding(active);
    try {
      await active.aborting;
    } finally {
      if (this.active.get(runId) === active) this.active.delete(runId);
    }
  }
  private async abortBinding(active: ActiveRun) {
    const context = {
      ...active.context,
      signal: AbortSignal.timeout(10_000),
      runId: active.context.runId,
    };
    for await (const _ of this.transport.request(
      { method: "codexAbort", ...active.binding },
      context,
    )) {
      /* Drain acknowledgement. */
    }
  }
  async *run(
    request: AgentRunRequest,
    supplied?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const native = request.nativeRuntime;
    if (
      native?.executionTarget !== "host" ||
      !native.computerKey ||
      !Number.isSafeInteger(native.historyGeneration) ||
      native.historyGeneration < 0 ||
      (native.contextScope !== undefined &&
        (typeof native.contextScope !== "string" ||
          !native.contextScope ||
          native.contextScope.length > 256)) ||
      !native.projectPath ||
      !["workspace", "full"].includes(native.permission)
    )
      throw new Error("Codex requires an explicit host project and supported permission policy");
    const toolBridge = new NativeToolBridge(request);
    const initialSteering =
      !request.turnCheckpoint && request.claimSteering ? await request.claimSteering([], true) : [];
    const steeringIds = new Set(initialSteering.map((item) => item.messageId));
    let checkpoint: Checkpoint = {
      runtime: this.nativeKind,
      version: 1,
      botId: request.botId,
      threadId: request.threadId,
      runId: request.runId,
      projectPath: native.projectPath,
      writeSubdirectory: native.writeSubdirectory,
      computerKey: native.computerKey,
      historyGeneration: native.historyGeneration,
      runtimeGeneration: native.runtimeGeneration ?? 0,
      contextScope: native.contextScope,
      permission: native.permission,
      after: 0,
      toolCatalogFingerprint: toolBridge.fingerprint,
      prompt: initialSteering.length
        ? `${request.prompt}\n\nAdditional user context:\n${initialSteering.map((item) => item.text).join("\n")}`
        : request.prompt,
      steeringIds: initialSteering.map((item) => item.id),
      instructions: request.instructions,
      model: request.model.id,
      thinkingLevel: request.model.thinkingLevel ?? null,
      history: buildNativeHistory(request.history, { excludeMessageIds: steeringIds }),
    };
    Object.assign(
      checkpoint,
      fitInlineImages(
        [
          ...(request.currentTurnImages ?? []),
          ...initialSteering.flatMap((item) => item.images ?? []),
        ],
        { method: "codexRun", ...checkpoint, config: native },
      ),
    );
    const freshCheckpoint = checkpoint;
    let handover = false;
    if (request.turnCheckpoint) {
      const restored = readCodexCheckpoint(request.turnCheckpoint);
      if (
        restored.runtime !== this.nativeKind ||
        (restored.introHandover && !nativeCheckpointBelongsToRun(restored, request.runId)) ||
        restored.botId !== request.botId ||
        restored.threadId !== request.threadId ||
        restored.projectPath !== native.projectPath ||
        restored.writeSubdirectory !== native.writeSubdirectory ||
        restored.computerKey !== native.computerKey ||
        restored.historyGeneration !== native.historyGeneration ||
        (restored.runtimeGeneration ?? 0) !== (native.runtimeGeneration ?? 0) ||
        restored.contextScope !== native.contextScope ||
        restored.permission !== native.permission
      )
        throw new Error("Native Codex checkpoint binding mismatch");
      if (!restored.completed) {
        handover =
          restored.introHandover?.phase === "stopping" ||
          (native.introAnswer !== undefined && !restored.introHandover);
        if (handover) {
          // Only the executor's persisted ordinary intro answer can authorize this
          // transition. Never answer/replay a pending effect under a broader catalog.
          const introTools = new NativeToolBridge({
            ...request,
            tools: request.tools.filter((tool) => ["ask_user", "update_bot"].includes(tool.name)),
          });
          if (
            !request.onCheckpoint ||
            restored.toolCatalogFingerprint !== introTools.fingerprint ||
            !native.introAnswer?.trim() ||
            !restored.approvalId ||
            restored.pendingToolCall ||
            (restored.introHandover && restored.introHandover.answer !== native.introAnswer)
          )
            throw new Error("Native intro handover binding mismatch");
        } else if (
          restored.toolCatalogFingerprint !== toolBridge.fingerprint &&
          (restored.toolCatalogFingerprint || toolBridge.catalog.length)
        )
          throw new Error("Native application tool catalog changed during the run");
        checkpoint = restored;
      }
    }
    const binding = {
      botId: checkpoint.botId,
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
    };
    const context: AdapterContext = {
      operationId: supplied?.operationId ?? request.runId,
      traceId: supplied?.traceId ?? request.runId,
      userId: supplied?.userId ?? "local",
      spaceId: supplied?.spaceId ?? "local",
      ...supplied,
      runId: supplied?.runId ?? request.runId,
      signal: supplied?.signal ?? new AbortController().signal,
    };
    const ownership: ActiveRun = { binding, context };
    this.active.set(request.runId, ownership);
    const stop = () => {
      void this.abortOwned(request.runId, ownership).catch(() => undefined);
    };
    context.signal.addEventListener("abort", stop, { once: true });
    let paused = false;
    const steeringStop = new AbortController();
    const streamFailure = new AbortController();
    let steeringTask: Promise<void> | undefined;
    let steeringError: unknown;
    const streamContext = {
      ...context,
      signal: AbortSignal.any([context.signal, streamFailure.signal]),
    };
    const steeringSignal = AbortSignal.any([streamContext.signal, steeringStop.signal]);
    const startSteering = () => {
      if (this.nativeKind !== "codex" || !request.claimSteering || steeringTask) return;
      steeringTask = (async () => {
        while (!steeringSignal.aborted) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              steeringSignal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 500);
            steeringSignal.addEventListener("abort", done, { once: true });
            if (steeringSignal.aborted) done();
          });
          if (steeringSignal.aborted) return;
          const steering = await request.claimSteering!(checkpoint.steeringIds ?? []);
          for (const [index, item] of steering.entries()) {
            context.signal.throwIfAborted();
            const deferRemaining = async () => {
              if (!request.deferSteering)
                throw new Error("Native steering continuation is unavailable");
              await request.deferSteering(steering.slice(index).map((entry) => entry.id));
            };
            if (steeringStop.signal.aborted) {
              await deferRemaining();
              return;
            }
            const input = {
              method: "codexSteer",
              ...binding,
              messageId: item.id,
              text: item.text,
            } as const;
            let outcome: HostCodexSteeringResult | undefined;
            for await (const result of this.transport.request<HostCodexSteeringResult>(
              { ...input, ...fitInlineImages(item.images, input) },
              context,
            )) {
              outcome = result;
            }
            if (outcome?.accepted === false) {
              await deferRemaining();
              return;
            }
            if (outcome?.accepted !== true)
              throw new Error("Native steering submission outcome is uncertain");
            checkpoint.steeringIds = [...(checkpoint.steeringIds ?? []), item.id];
            const blob = JSON.stringify(checkpoint);
            await request.onCheckpoint?.(() => blob, "native-start");
          }
        }
      })().catch((error) => {
        if (!context.signal.aborted) {
          steeringError = error;
          streamFailure.abort(error);
        }
      });
    };
    const executePendingTool = async () => {
      const call = checkpoint.pendingToolCall;
      if (!call) return false;
      if (
        !toolBridge.has(call.tool) ||
        call.executionId !== JSON.stringify(["native-tool", checkpoint.runId, call.callId])
      )
        throw new Error("Native application tool checkpoint binding mismatch");
      // Capture by reference: effect gates add their occurrence before persisting a pause.
      await request.onCheckpoint?.(() => JSON.stringify(checkpoint), call.executionId);
      await request.onCheckpoint?.(() => JSON.stringify(checkpoint), "native-start");
      if (!call.response) {
        const outcome = await toolBridge.execute(call, context.signal);
        if (outcome.paused) {
          paused = true;
          steeringStop.abort();
          await steeringTask;
          return true;
        }
        call.response = outcome.response;
        // Durably retain the result before replying, including if the reply's acknowledgement is lost.
        await request.onCheckpoint?.(() => JSON.stringify(checkpoint), "native-start");
      }
      context.signal.throwIfAborted();
      for await (const _ of this.transport.request(
        {
          method: "codexToolResult",
          ...binding,
          callId: call.callId,
          response: call.response,
        },
        context,
      )) {
        /* Drain acknowledgement. */
      }
      checkpoint.pendingToolCall = undefined;
      await request.onCheckpoint?.(() => JSON.stringify(checkpoint), "native-start");
      return false;
    };
    try {
      context.signal.throwIfAborted();
      if (handover) {
        try {
          checkpoint.introHandover = {
            applicationRunId: request.runId,
            phase: "stopping",
            answer: native.introAnswer!,
          };
          // Persist intent and the original physical Stop target before cleanup.
          await request.onCheckpoint?.(() => JSON.stringify(checkpoint), "native-start");
          let verified = false;
          for await (const result of this.transport.request<{ cleanupVerified?: boolean }>(
            {
              method: "codexRetire",
              ...binding,
              computerKey: checkpoint.computerKey,
            },
            context,
          )) {
            verified ||= result?.cleanupVerified === true;
          }
          if (!verified) throw new Error("Native intro cleanup was not verified");
          context.signal.throwIfAborted();
          checkpoint = {
            ...freshCheckpoint,
            runId: nativeIntroExecutionId(request.runId),
            prompt: checkpoint.introHandover.answer,
            introHandover: { ...checkpoint.introHandover, phase: "ready" },
          };
          binding.runId = checkpoint.runId;
          // The full catalog is new provider state, with a fresh cursor and no old
          // pending tool. Atomically pin its Stop target before the host sees it.
          await request.onCheckpoint?.(() => JSON.stringify(checkpoint), "native-start");
        } catch (cause) {
          throw new NativeIntroHandoverError("Native intro handover could not finish", { cause });
        }
      }
      if (checkpoint.pendingToolCall && (await executePendingTool())) {
        yield { type: "checkpoint", blob: JSON.stringify(checkpoint) };
        return;
      }
      if (checkpoint.approvalId) {
        const answer = request.resumeToolResult?.content
          .map((item) => item.text)
          .join("\n")
          .trim();
        if (!answer) {
          // A crash can persist the native cursor just before the ask card's
          // transaction commits. Replay that ask; absence of input never approves it.
          checkpoint.after = Math.max(0, checkpoint.after - 1);
        } else {
          for await (const _ of this.transport.request(
            { method: "codexAnswer", ...binding, approvalId: checkpoint.approvalId, answer },
            context,
          )) {
            /* Drain acknowledgement. */
          }
          checkpoint.approvalId = undefined;
        }
      }
      // Persist the exact prompt before the host can accept work. An uncertain
      // start then resumes the same native binding instead of rebuilding its input.
      const initialBlob = JSON.stringify(checkpoint);
      await request.onCheckpoint?.(() => initialBlob, "native-start");
      for await (const envelope of this.transport.request<HostCodexEvent>(
        {
          method:
            checkpoint.model !== "default" || checkpoint.thinkingLevel != null
              ? "codexRunModelSettings"
              : checkpoint.contextScope
                ? "codexRunContextScoped"
                : checkpoint.writeSubdirectory
                  ? "codexRunScoped"
                  : "codexRun",
          ...binding,
          config: {
            projectPath: checkpoint.projectPath,
            writeSubdirectory: checkpoint.writeSubdirectory,
            permission: checkpoint.permission,
            computerKey: checkpoint.computerKey,
            historyGeneration: checkpoint.historyGeneration,
            runtimeGeneration: checkpoint.runtimeGeneration,
            contextScope: checkpoint.contextScope,
            ...(checkpoint.introHandover?.phase === "ready"
              ? { applicationRunId: checkpoint.introHandover.applicationRunId }
              : {}),
          },
          prompt: checkpoint.prompt,
          images: checkpoint.images,
          imageFallback: checkpoint.imageFallback,
          instructions: checkpoint.instructions,
          model: checkpoint.model,
          thinkingLevel: checkpoint.thinkingLevel,
          tools: toolBridge.catalog,
          toolCatalogFingerprint: checkpoint.toolCatalogFingerprint ?? toolBridge.fingerprint,
          history: checkpoint.history,
          session: checkpoint.session,
          after: checkpoint.after,
        },
        streamContext,
      )) {
        if (envelope.sequence <= checkpoint.after) continue;
        if (envelope.event.type === "done") {
          steeringStop.abort();
          await steeringTask;
          if (steeringError) throw steeringError;
        }
        if (envelope.outputFile && request.onOutputFile) {
          await request.onOutputFile({
            id: envelope.outputFile.id,
            path: envelope.outputFile.path,
            bytes: Buffer.from(envelope.outputFile.content, "base64"),
          });
        }
        checkpoint.after = envelope.sequence;
        checkpoint.session = envelope.session ?? checkpoint.session;
        checkpoint.approvalId = envelope.approvalId;
        checkpoint.completed = envelope.event.type === "done";
        if (envelope.toolCall) {
          if (checkpoint.approvalId || checkpoint.pendingToolCall)
            throw new Error("Native application tool interaction overlap");
          checkpoint.pendingToolCall = {
            callId: envelope.toolCall.callId,
            tool: envelope.toolCall.tool,
            arguments: structuredClone(envelope.toolCall.arguments),
            executionId: envelope.toolCall.executionId,
          };
          if (await executePendingTool()) {
            // The consumer must observe an event after the gate sets pausePending.
            // Returning without yielding would incorrectly complete the application run.
            yield { type: "checkpoint", blob: JSON.stringify(checkpoint) };
            return;
          }
        }
        let event = envelope.event;
        if (event.type === "usage" && request.onUsage) {
          await request.onUsage(event);
          event = { ...event, accounted: true };
        }
        const blob = JSON.stringify(checkpoint);
        yield { type: "checkpoint", blob };
        if (envelope.event.type === "ask") {
          steeringStop.abort();
          await steeringTask;
          if (steeringError) throw steeringError;
          await request.onCheckpoint?.(() => blob, envelope.event.executionId!);
          paused = true;
          const expiry = setTimeout(() => {
            if (this.active.get(request.runId) === ownership) this.active.delete(request.runId);
          }, 30 * 60_000);
          expiry.unref();
          yield envelope.event;
          return;
        }
        if (event.type !== "done") startSteering();
        yield event;
      }
      steeringStop.abort();
      await steeringTask;
      if (steeringError) throw steeringError;
    } catch (error) {
      // A retained tool reply can be resubmitted after a lost host acknowledgement.
      if (
        (error instanceof NativeIntroHandoverError ||
          checkpoint.pendingToolCall?.response ||
          checkpoint.introHandover?.phase === "stopping") &&
        !context.signal.aborted
      )
        paused = true;
      throw steeringError ?? error;
    } finally {
      steeringStop.abort();
      await steeringTask;
      context.signal.removeEventListener("abort", stop);
      if (paused) {
        const expiry = setTimeout(() => {
          if (this.active.get(request.runId) === ownership) this.active.delete(request.runId);
        }, 30 * 60_000);
        expiry.unref();
      }
      if (!paused) {
        if (!checkpoint.completed) {
          await this.abortOwned(request.runId, ownership).catch(() => undefined);
        }
        if (this.active.get(request.runId) === ownership) this.active.delete(request.runId);
      }
    }
  }
}
