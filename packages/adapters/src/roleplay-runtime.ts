import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import type { AgentRunModel, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { RoleplayMessage } from "@rakazo/core";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { withCloudflareAuth } from "./cloudflare-ai-gateway.js";
import {
  assistantText,
  messageHasToolCall,
  modelFailure,
  providerFailureText,
} from "./pi-runtime-errors.js";
import { modelForCompletion, resolveRuntimeModel, thinkingLevelFor } from "./pi-runtime-models.js";
import { reliableModelStream } from "./pi-runtime-stream.js";
import { observedPiStream } from "./pi-usage.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export type RoleplayRuntimeEvent = { type: "text"; text: string } | { type: "done"; text: string };

/** Deliberately has no tools, sandbox, checkpoints, agent memory, or executable callbacks. */
export interface RoleplayRunRequest {
  runId: string;
  threadId: string;
  botId: string;
  historyGeneration: number;
  purpose: "dialogue" | "memory";
  model: AgentRunModel;
  instructions: string;
  history: RoleplayMessage[];
  prompt: string;
  onUsage?: (event: UsageEvent) => void | Promise<void>;
}

export interface RoleplayRuntime {
  run(request: RoleplayRunRequest, signal: AbortSignal): AsyncIterable<RoleplayRuntimeEvent>;
  abort(runId: string): Promise<void>;
}

/** A single text completion, sharing only provider transport and accounting with Pi. */
export class InternalRoleplayRuntime implements RoleplayRuntime {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: { modelFetch?: typeof globalThis.fetch } = {}) {}

  async abort(runId: string): Promise<void> {
    this.running.get(runId)?.abort();
  }

  run(
    request: RoleplayRunRequest,
    upstream: AbortSignal,
  ): AsyncIterableIterator<RoleplayRuntimeEvent> {
    const controller = new AbortController();
    const events = this.runEvents(
      request,
      AbortSignal.any([controller.signal, upstream]),
      controller,
    );
    this.running.set(request.runId, controller);
    const cleanup = () => {
      if (this.running.get(request.runId) === controller) this.running.delete(request.runId);
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        try {
          const event = await events.next();
          if (event.done) cleanup();
          return event;
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      return: async () => {
        controller.abort();
        try {
          return await events.return(undefined);
        } finally {
          cleanup();
        }
      },
      throw: async (error) => {
        controller.abort();
        try {
          return await events.throw(error);
        } finally {
          cleanup();
        }
      },
    };
  }

  private async *runEvents(
    request: RoleplayRunRequest,
    signal: AbortSignal,
    controller: AbortController,
  ): AsyncGenerator<RoleplayRuntimeEvent> {
    signal.throwIfAborted();
    if (request.model.provider === "scripted") throw new Error(MISSING_MODEL_RUN_ERROR);
    const resolved = resolveRuntimeModel(request.model);
    if (!resolved.model) throw new Error("Unknown roleplay model");
    const model = modelForCompletion(resolved.model, request.model.maxTokens);
    const messages: Message[] = request.history.map((message) =>
      message.role === "user"
        ? { role: "user", content: message.content, timestamp: 0 }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
          },
    );
    messages.push({ role: "user", content: request.prompt, timestamp: Date.now() });
    // No tool definitions are sent, including when a card asks to run a command.
    const thinking = thinkingLevelFor(model, request.model.thinkingLevel);
    const context: Context = { systemPrompt: request.instructions, messages };
    const stream = reliableModelStream(
      resolved.models,
      model,
      context,
      withCloudflareAuth(request.model, {
        signal,
        apiKey: resolved.apiKey,
        fetch: this.options.modelFetch,
        reasoning: thinking === "off" ? undefined : thinking,
        sessionId: `roleplay:${request.threadId}:${request.botId}:${request.historyGeneration}:${request.purpose}`,
        headers: request.model.headers,
      }),
      request.model.maxTokens,
      () => resolved.credentials?.accessToken ?? resolved.apiKey,
      (options) =>
        observedPiStream(
          resolved.models,
          model,
          context,
          options,
          () => undefined,
          request.model.callObserver,
          {
            operationKind: request.purpose === "memory" ? "compaction" : "answer",
            runId: request.runId,
          },
          { recordUsage: request.onUsage },
        ),
      request.model.cacheCapabilities?.retentionMode,
    );
    let final: AssistantMessage | undefined;
    try {
      for await (const event of stream) {
        signal.throwIfAborted();
        if (event.type === "text_delta") yield { type: "text", text: event.delta };
        if (event.type === "done") final = event.message;
        if (event.type === "error") {
          signal.throwIfAborted();
          throw modelFailure(
            event.error.errorMessage ?? "The roleplay model failed",
            "The roleplay model failed",
          );
        }
      }
      signal.throwIfAborted();
      if (!final) throw new Error("The roleplay model returned no response");
      const failure = providerFailureText(final);
      if (failure) throw modelFailure(failure, failure);
      if (messageHasToolCall(final)) throw new Error("Roleplay models cannot call tools");
      const text = assistantText(final);
      if (!text.trim()) throw new Error("The roleplay model returned no text");
      yield { type: "done", text };
    } finally {
      // Closing a consumer immediately aborts any provider request still in flight.
      controller.abort();
    }
  }
}
