import { ORPCError } from "@orpc/server";
import type { Actor, Bot, RuntimeModels, SetRuntimeModelInput } from "@rakazo/contracts";
import { RuntimeModelsSchema } from "@rakazo/contracts";
import {
  BotExecutionSettingsError,
  IsolationError,
  setBotRuntimeModel as persistRuntimeModel,
} from "@rakazo/db";
import { assertNativeSetupAdmission } from "./native-setup-admission.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

export async function loadBotRuntimeModels(
  deps: RouterDeps,
  actor: Actor,
  bot: Pick<Bot, "id" | "runtimeKind" | "executionTarget" | "projectPath"> & {
    threadId: string | null;
  },
  signal?: AbortSignal,
): Promise<RuntimeModels> {
  const runtimeKind = bot.runtimeKind ?? "pi";
  const unavailable = (reason: RuntimeModels["reason"]): RuntimeModels => ({
    runtimeKind,
    available: false,
    models: [],
    defaultModelId: null,
    reason,
  });
  if (runtimeKind !== "codex") return unavailable("unsupported-runtime");
  if (
    !deps.nativeRuntimeModels ||
    bot.executionTarget !== "host" ||
    !bot.projectPath ||
    !bot.threadId
  )
    return unavailable("host-unavailable");
  try {
    await deps.prisma.$transaction((tx) => assertNativeSetupAdmission(tx, actor));
    const catalog = RuntimeModelsSchema.parse(
      await deps.nativeRuntimeModels(bot.id, bot.threadId, {
        ...computerContext(actor, bot.id, "bots.runtimeModels"),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }),
    );
    if (catalog.runtimeKind !== runtimeKind) return unavailable("host-unavailable");
    return catalog;
  } catch {
    return unavailable("host-unavailable");
  }
}

export async function setBotRuntimeModel(
  deps: RouterDeps,
  actor: Actor,
  input: SetRuntimeModelInput,
  signal?: AbortSignal,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    include: { thread: { select: { id: true } } },
  });
  if (!bot) throw new IsolationError();
  // Discovery is an authenticated read on exactly this bot's current host.
  const catalog = await loadBotRuntimeModels(
    deps,
    actor,
    {
      ...bot,
      runtimeKind: bot.runtimeKind as Bot["runtimeKind"],
      executionTarget: bot.executionTarget as Bot["executionTarget"],
      threadId: bot.thread?.id ?? null,
    },
    signal,
  );
  if (!catalog.available)
    throw new ORPCError("BAD_REQUEST", {
      message: "Model selection is unavailable for this runtime",
    });
  const model =
    input.modelId === null ? null : catalog.models.find((row) => row.id === input.modelId);
  if (input.modelId !== null && !model)
    throw new ORPCError("BAD_REQUEST", { message: "That model is unavailable on this host" });
  if (input.thinkingLevel !== null && !model?.thinkingLevels.includes(input.thinkingLevel))
    throw new ORPCError("BAD_REQUEST", {
      message: "That reasoning effort is unavailable for this model",
    });
  try {
    const event = await persistRuntimeModel(deps.prisma, actor, input, {
      runtimeKind: bot.runtimeKind,
      runtimeGeneration: bot.runtimeGeneration,
      registeredHostId: bot.registeredHostId,
      projectPath: bot.projectPath,
    });
    await deps.events.notify(event.threadId, event.seq).catch(() => undefined);
  } catch (error) {
    if (error instanceof BotExecutionSettingsError)
      throw new ORPCError("CONFLICT", { message: error.message });
    throw error;
  }
}
