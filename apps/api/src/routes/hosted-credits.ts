import { createHostedCreditServices } from "../hosted-credits.js";
import type { RouterContext } from "./context.js";

export function hostedCreditRoutes({ deps, authed }: RouterContext) {
  const service = createHostedCreditServices(deps);
  return {
    hostedCredits: {
      status: authed.hostedCredits.status.handler(({ context }) => service.status(context.actor)),
      tariffs: authed.hostedCredits.tariffs.handler(() => service.publicTariffs()),
    },
    creditAdmin: {
      overview: authed.creditAdmin.overview.handler(({ context }) =>
        service.overview(context.actor),
      ),
      accounts: authed.creditAdmin.accounts.handler(({ context, input }) =>
        service.accounts(context.actor, input),
      ),
      journal: authed.creditAdmin.journal.handler(({ context, input }) =>
        service.journal(context.actor, input),
      ),
      policy: authed.creditAdmin.policy.handler(({ context }) => service.policy(context.actor)),
      updatePolicy: authed.creditAdmin.updatePolicy.handler(({ context, input }) =>
        service.updatePolicy(context.actor, input),
      ),
      tariffs: authed.creditAdmin.tariffs.handler(({ context }) => service.tariffs(context.actor)),
      updateTariff: authed.creditAdmin.updateTariff.handler(({ context, input }) =>
        service.updateTariff(context.actor, input),
      ),
      adjustment: authed.creditAdmin.adjustment.handler(({ context, input }) =>
        service.adjustment(context.actor, input),
      ),
      updateAllowance: authed.creditAdmin.updateAllowance.handler(({ context, input }) =>
        service.updateAllowance(context.actor, input),
      ),
      costReport: authed.creditAdmin.costReport.handler(({ context, input }) =>
        service.costReport(context.actor, input),
      ),
    },
  };
}
