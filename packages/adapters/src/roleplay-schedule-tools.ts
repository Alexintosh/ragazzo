import type { ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { z } from "zod";
import {
  claimIntendedEffect,
  resolveDuplicateEffectGate,
  uncertainEffectResult,
} from "./approval-effect.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { completeEffect, recordEffect } from "./run-effects.js";
import {
  cancelScheduleFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  filterBuiltinToolsForRun,
  listSchedulesFromTool,
  updateScheduleFromTool,
} from "./schedule-tools.js";

const text = z.string().trim().min(1).max(200);
const details = {
  name: text,
  prompt: z.string().trim().min(1).max(8_000),
  timezone: text.optional(),
};
const timing = {
  cron: z.string().trim().min(1).max(120).optional(),
  every: z.number().finite().positive().int().optional(),
  unit: z.enum(["minutes", "hours", "days"]).optional(),
  runAt: text.optional(),
  delayMinutes: z.number().finite().nonnegative().optional(),
  delaySeconds: z.number().finite().nonnegative().optional(),
  startAt: text.optional(),
};
const schemas = {
  schedule_create: z.strictObject({ ...details, ...timing }),
  schedule_list: z.strictObject({
    page: z.number().int().min(1).max(1_000_000).optional(),
    includeInactive: z.boolean().optional(),
  }),
  schedule_update: z.strictObject({
    routineId: text,
    name: details.name.optional(),
    prompt: details.prompt.optional(),
    timezone: details.timezone,
    active: z.boolean().optional(),
    ...timing,
  }),
  schedule_cancel: z.strictObject({
    routineId: text.optional(),
    name: text.optional(),
  }),
};

const descriptions: Record<keyof typeof schemas, string> = {
  schedule_create:
    "Schedule a future message from this character in this conversation. For a promise such as 'I'll write in 45 minutes', call this with delayMinutes:45 before confirming it. Supply a short name and a prompt describing the future message. Use exactly one timing method: runAt, delayMinutes, delaySeconds, cron, or every+unit. Repeating schedules may use startAt. Only report success after a successful tool result; never claim a timer from dialogue alone. This schedules chat only; it cannot perform external activities.",
  schedule_list:
    "List this character's schedules in this conversation, ten per page. Defaults to active schedules and page:1. Use includeInactive:true for past or paused schedules; follow nextPage when present.",
  schedule_update:
    "Change this character's existing schedule in this conversation by routineId. Send only changed fields; timing uses the same methods as schedule_create. active:false pauses it.",
  schedule_cancel:
    "Cancel this character's schedule in this conversation by routineId or exact name.",
};

export interface RoleplayScheduling {
  tools: ConnectorTool[];
  execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Keep ten compact rows below the runtime's tool-result byte budget, including Unicode. */
function boundedScheduleText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(value)).length <= maxBytes + 2)
    return value;
  let result = "";
  let bytes = 0;
  for (const point of value) {
    const cost = encoder.encode(JSON.stringify(point)).length - 2;
    if (bytes + cost > maxBytes - 3) break;
    result += point;
    bytes += cost;
  }
  return `${result}…`;
}

function compactScheduleResult(result: unknown): unknown {
  if (!result || typeof result !== "object")
    return { error: "Invalid scheduling result." };
  const value = result as Record<string, unknown>;
  if (typeof value.error === "string")
    return {
      error: boundedScheduleText(value.error, 800),
      ...(value.uncertain === true ? { uncertain: true } : {}),
    };
  return {
    ...(value.ok === true ? { ok: true } : {}),
    ...(typeof value.routineId === "string"
      ? { routineId: value.routineId }
      : {}),
    ...(typeof value.name === "string"
      ? { name: boundedScheduleText(value.name, 120) }
      : {}),
    ...(typeof value.active === "boolean" ? { active: value.active } : {}),
    ...(typeof value.oneShot === "boolean" ? { oneShot: value.oneShot } : {}),
    ...(value.nextRunAt === null || typeof value.nextRunAt === "string"
      ? { nextRunAt: value.nextRunAt }
      : {}),
    ...(typeof value.timezone === "string"
      ? { timezone: boundedScheduleText(value.timezone, 80) }
      : {}),
    ...(typeof value.schedule === "string"
      ? { schedule: boundedScheduleText(value.schedule, 160) }
      : {}),
    ...(value.nextRun === null || typeof value.nextRun === "string"
      ? {
          nextRun:
            value.nextRun === null
              ? null
              : boundedScheduleText(value.nextRun, 120),
        }
      : {}),
  };
}

/** A closed chat-only tool surface; the executor supplies the already-validated story identity. */
export function createRoleplayScheduling(
  deps: ExecutorDeps,
  identity: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
  },
): RoleplayScheduling {
  const {
    id: runId,
    trigger: runTrigger,
    spaceId,
    userId,
    botId,
    threadId,
  } = identity;
  const scope = { spaceId, userId, botId, threadId };
  const occurrences = new Map<string, number>();
  const tools = filterBuiltinToolsForRun(
    Object.entries(schemas).map(([name, schema]) => ({
      name,
      description: descriptions[name as keyof typeof schemas],
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
    })),
    runTrigger,
  );
  // Spontaneous and internal memory requests cannot create unattended follow-on work.
  const allowed = new Set(
    tools
      .filter(
        (tool) =>
          runTrigger === "user" ||
          runTrigger === "follow_up" ||
          tool.name === "schedule_list" ||
          tool.name === "schedule_cancel",
      )
      .map((tool) => tool.name),
  );
  return {
    tools: tools.filter((tool) => allowed.has(tool.name)),
    async execute(name, args, signal) {
      signal.throwIfAborted();
      if (!allowed.has(name))
        return { error: "This scheduling tool is unavailable for this turn." };
      const key = name as keyof typeof schemas;
      // Reject hidden capabilities even when a model bypasses its advertised schema.
      const parsed = schemas[key].safeParse(compactScheduleInput(args));
      if (!parsed.success) return { error: "Invalid scheduling arguments." };
      signal.throwIfAborted();
      if (key === "schedule_list") {
        const { page = 1, includeInactive = false } =
          schemas.schedule_list.parse(parsed.data);
        const { routines } = await listSchedulesFromTool(deps, scope, {
          activeOnly: !includeInactive,
          skip: (page - 1) * 10,
          take: 11,
        });
        signal.throwIfAborted();
        return {
          routines: routines.slice(0, 10).map((routine) => ({
            routineId: routine.routineId,
            name: boundedScheduleText(routine.name, 120),
            active: routine.active,
            nextRunAt: routine.nextRunAt,
            timezone: boundedScheduleText(routine.timezone, 80),
            ...(routine.schedule
              ? { schedule: boundedScheduleText(routine.schedule, 160) }
              : {}),
          })),
          nextPage: routines.length > 10 ? page + 1 : null,
        };
      }
      const request = parsed.data;
      const baseKey = toolEffectIdempotencyKey(runId, key, request);
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      // Replaying a completion after a worker restart must not create a second timer.
      // An interrupted executing mutation stays uncertain and is never blindly repeated.
      const recorded = await recordEffect(
        deps,
        { id: runId, ...scope },
        key,
        toolEffectIdempotencyKey(runId, key, request, occurrence),
        request,
      );
      if (recorded.effect.status !== "intended") {
        const gate = resolveDuplicateEffectGate(recorded.effect, key);
        return gate.action === "return"
          ? compactScheduleResult(gate.result)
          : uncertainEffectResult(key, request);
      }
      signal.throwIfAborted();
      if (!(await claimIntendedEffect(deps.prisma, recorded.effect.id)))
        return uncertainEffectResult(key, request);
      signal.throwIfAborted();
      const finish = async (result: unknown) => {
        const compact = compactScheduleResult(result);
        return (await completeEffect(
          deps,
          recorded.effect.id,
          "executing",
          compact,
        ))
          ? compact
          : uncertainEffectResult(key, request);
      };
      if (key === "schedule_create") {
        const input = schemas.schedule_create.parse(parsed.data);
        const { name, prompt, timezone, ...schedule } = input;
        return finish(
          await createScheduleFromTool(
            { ...deps, signal },
            {
              ...scope,
              name,
              prompt,
              timezone,
              schedule,
            },
          ),
        );
      }
      if (key === "schedule_update") {
        const input = schemas.schedule_update.parse(parsed.data);
        const { routineId, name, prompt, timezone, active, ...schedule } =
          input;
        return finish(
          await updateScheduleFromTool(
            { ...deps, signal },
            {
              ...scope,
              scopeThreadId: scope.threadId,
              routineId,
              name,
              prompt,
              timezone,
              active,
              schedule,
            },
          ),
        );
      }
      if (key === "schedule_cancel")
        return finish(
          await cancelScheduleFromTool(
            { ...deps, signal },
            {
              ...scope,
              ...schemas.schedule_cancel.parse(parsed.data),
            },
          ),
        );
      return { error: "This scheduling tool is unavailable for this turn." };
    },
  };
}
