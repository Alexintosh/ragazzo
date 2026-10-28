import { ORPCError } from "@orpc/server";
import { assertNativeSetupAdmission } from "../native-setup-admission.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function nativeSetupRoutes({ deps, authed }: RouterContext) {
  return {
    nativeSetup: {
      request: authed.nativeSetup.request.handler(async ({ context, input }) => {
        if (!deps.nativeSetup) throw new ORPCError("NOT_FOUND");
        try {
          if (input.action !== "cancel")
            await deps.prisma.$transaction(async (tx) => {
              await assertNativeSetupAdmission(tx, context.actor);
              const owner = { spaceId: context.actor.spaceId, userId: context.actor.userId };
              await tx.nativeSetupOwner.upsert({
                where: { spaceId_userId: owner },
                create: owner,
                update: {},
              });
            });
          return await deps.nativeSetup(input, {
            ...computerContext(context.actor, "setup", "nativeSetup.request"),
            signal: context.signal ?? AbortSignal.timeout(30_000),
          });
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Runtime setup unavailable. Check the selected host and local consent.",
          });
        }
      }),
    },
  };
}
