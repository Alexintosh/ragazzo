import { ORPCError } from "@orpc/server";
import { farmingControlMentionKinds } from "@rakazo/core";
import { FarmingControlAccessError } from "@rakazo/adapters";
import { ensureFarmingControlTeam } from "../farming-control-team.js";
import type { RouterContext } from "./context.js";

async function api<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FarmingControlAccessError)
      throw new ORPCError(error.code, { message: error.message });
    throw error;
  }
}

export function farmingControlRoutes({ deps, authed }: RouterContext) {
  const service = () => {
    if (!deps.farmingControl) throw new ORPCError("NOT_FOUND");
    return deps.farmingControl;
  };
  return {
    farmingControl: {
      status: authed.farmingControl.status.handler(async ({ context }) =>
        api(() => service().status(context.actor)),
      ),
      positionHistory: authed.farmingControl.positionHistory.handler(({ context, input }) =>
        api(() => service().positionHistory(context.actor, input)),
      ),
      mentionTargets: authed.farmingControl.mentionTargets.handler(({ context, input }) =>
        api(async () => {
          await service().authorize(context.actor);
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true, spaceId: true, spawnKey: true },
          });
          const allowed = farmingControlMentionKinds(bot);
          if (!allowed.length) throw new ORPCError("FORBIDDEN");
          const kinds = input.kinds ?? allowed.filter((kind) => kind !== "risk");
          if (kinds.some((kind) => !allowed.includes(kind))) throw new ORPCError("FORBIDDEN");
          const { botId: _botId, ...query } = input;
          return service().mentionTargets(context.actor, { ...query, kinds });
        }),
      ),
      portfolio: authed.farmingControl.portfolio.handler(({ context, input }) =>
        api(() => service().portfolio(context.actor, input)),
      ),
      harvest: authed.farmingControl.harvest.handler(({ context }) =>
        api(() => service().harvest(context.actor)),
      ),
      risk: authed.farmingControl.risk.handler(({ context }) =>
        api(() => service().risk(context.actor)),
      ),
      accounting: authed.farmingControl.accounting.handler(({ context }) =>
        api(() => service().accounting(context.actor)),
      ),
      ensureTeam: authed.farmingControl.ensureTeam.handler(async ({ context }) =>
        api(async () => {
          await service().authorize(context.actor);
          if (!service().configured) throw new ORPCError("NOT_FOUND");
          return ensureFarmingControlTeam(deps.prisma, context.actor);
        }),
      ),
    },
  };
}
