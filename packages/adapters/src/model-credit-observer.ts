import type { ModelCallObserver } from "@rakazo/adapter-kit";
import { HOSTED_MODEL_CREDITS_REQUIRED_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  creditAccount,
  getHostedCreditPolicy,
  hostedModelMeteringEnabled,
  organizationForMember,
  recordModelCreditReceipt,
  reserveModelCredits,
} from "@rakazo/db";

export class HostedModelCreditsRequiredError extends Error {}

/** Deployment credentials recheck live policy for every invocation, including later tool turns. */
export async function hostedModelCreditObserver(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
): Promise<ModelCallObserver> {
  const meteredOrganization = async () => {
    if (!(await hostedModelMeteringEnabled(prisma))) return undefined;
    const membership = await organizationForMember(prisma, scope);
    if (!membership) throw new Error("Model credit account is unavailable");
    const account = await creditAccount(prisma, membership.organizationId);
    const policy = await getHostedCreditPolicy(prisma);
    if (
      (policy.activatedAt && !policy.enabled) ||
      (account.mode !== "credits" && !(policy.enabled && account.mode === null))
    )
      throw new HostedModelCreditsRequiredError(HOSTED_MODEL_CREDITS_REQUIRED_ERROR);
    return membership.organizationId;
  };
  // Surface an existing setup problem at resolution, then recheck when each request starts.
  await meteredOrganization();
  return {
    beforeCall: async (call) => {
      const organizationId = await meteredOrganization();
      if (!organizationId) return undefined;
      return reserveModelCredits(prisma, organizationId, call.maxCostUsd ?? Number.NaN, {
        callId: call.callId,
        userId: scope.userId,
        spaceId: scope.spaceId,
        runId: call.runId,
        provider: call.provider,
        model: call.modelId,
      });
    },
    afterCall: (reservationId, usage) => recordModelCreditReceipt(prisma, reservationId, usage),
    onRequestId: async (id, providerRequestId) => {
      await prisma.modelCreditEntry.updateMany({
        where: { id, providerRequestId: null },
        data: { providerRequestId },
      });
    },
  };
}
