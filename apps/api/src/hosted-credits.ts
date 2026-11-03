import { ORPCError } from "@orpc/server";
import type {
  Actor,
  BillingStatus,
  CreditCostReportInput,
  CreditCostReportRow,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  adjustModelCredits,
  creditAccount,
  getHostedCreditPolicy,
  hostedCreditStatus,
  listHostedCreditTariffs,
  organizationForMember,
  Prisma,
  runAsSystem,
  setHostedCreditAllowance,
  setHostedCreditTariff,
  updateHostedCreditPolicy,
} from "@rakazo/db";
import { isAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export function policyDto(policy: Awaited<ReturnType<typeof getHostedCreditPolicy>>) {
  return {
    enabled: policy.enabled,
    defaultDailyAllowanceMicros: policy.defaultDailyAllowanceMicros.toString(),
    dailyGrantBudgetMicros: policy.dailyGrantBudgetMicros.toString(),
  };
}

/** Financial projections and raw provider receipts never leave this module. */
export function journalDto(event: {
  id: string;
  kind: string;
  organizationId: string | null;
  amountMicros: bigint;
  provider: string | null;
  model: string | null;
  details: unknown;
  createdAt: Date;
}) {
  const details = record(event.details);
  const current = record(details.entry ?? details.current ?? details.after);
  return {
    id: event.id,
    kind: event.kind,
    organizationId: event.organizationId,
    amountMicros: event.amountMicros.toString(),
    provider: event.provider,
    model: event.model,
    actorId: stringOrNull(details.actorId ?? current.actorId),
    reason: stringOrNull(details.reason ?? current.reason),
    createdAt: event.createdAt.toISOString(),
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

export async function hostedCostReport(prisma: PrismaClient, input: CreditCostReportInput) {
  // Financial history survives account deletion. Use the latest immutable call and
  // usage snapshots, each keyed by its original row/call identity, rather than lifecycle rows.
  const rows = await prisma.$queryRaw<
    Array<{
      provider: string;
      model: string;
      providerCostUsd: number;
      chargedMicros: bigint;
      pendingMicros: bigint;
      knownCostCount: bigint;
      unknownCostCount: bigint;
      pendingCount: bigint;
    }>
  >(Prisma.sql`
    WITH snapshots AS (
      SELECT COALESCE(details->'entry',details) AS entry
      FROM billing_audit_events
      WHERE (source LIKE 'credit:%' OR kind='baseline')
        ${input.organizationId ? Prisma.sql`AND "organizationId"=${input.organizationId}` : Prisma.empty}
    ), latest_calls AS (
      SELECT DISTINCT ON (entry->>'id') entry
      FROM snapshots
      WHERE entry->>'source' LIKE 'call:%'
        AND (entry->>'createdAt')::timestamp>=${new Date(`${input.from}T00:00:00.000Z`)}
        AND (entry->>'createdAt')::timestamp<${new Date(`${input.to}T00:00:00.000Z`)}
      ORDER BY entry->>'id',COALESCE((entry->>'auditRevision')::bigint,0) DESC
    ), e AS (
      SELECT entry->>'callId' AS "callId",entry->>'provider' AS provider,
        entry->>'model' AS model,(entry->>'amountMicros')::numeric AS "amountMicros",
        COALESCE((entry->>'pending')::boolean,false) AS pending FROM latest_calls
    ), receipts AS (
      SELECT DISTINCT ON ("callId") "callId",details
      FROM billing_audit_events
      WHERE kind IN ('usage','usage_correction','usage_baseline')
        AND "callId" IN (SELECT "callId" FROM e)
      ORDER BY "callId",COALESCE((details->>'auditRevision')::bigint,0) DESC
    ), u AS (
      SELECT "callId",details->>'id' AS id,details->>'provider' AS provider,
        details->>'model' AS model,COALESCE(details->>'currency','usd') AS currency,
        (details->>'costUsd')::float8 AS "costUsd" FROM receipts
    )
    SELECT COALESCE(e.provider,u.provider,'unknown') AS provider,
      COALESCE(e.model,u.model,'unknown') AS model,
      COALESCE(SUM(CASE WHEN u.currency='usd' AND u."costUsd">=0
        AND u."costUsd"<'Infinity'::float8 THEN u."costUsd" ELSE 0 END),0)::float8 AS "providerCostUsd",
      COALESCE(SUM(CASE WHEN NOT e.pending THEN GREATEST(-e."amountMicros",0) ELSE 0 END),0)::bigint AS "chargedMicros",
      COALESCE(SUM(CASE WHEN e.pending THEN GREATEST(-e."amountMicros",0) ELSE 0 END),0)::bigint AS "pendingMicros",
      COUNT(*) FILTER (WHERE u.currency='usd' AND u."costUsd">=0 AND u."costUsd"<'Infinity'::float8) AS "knownCostCount",
      COUNT(*) FILTER (WHERE u.id IS NULL OR u.currency<>'usd' OR u."costUsd" IS NULL OR u."costUsd"<0 OR NOT u."costUsd"<'Infinity'::float8) AS "unknownCostCount",
      COUNT(*) FILTER (WHERE e.pending) AS "pendingCount"
    FROM e LEFT JOIN u ON u."callId"=e."callId"
    GROUP BY COALESCE(e.provider,u.provider,'unknown'), COALESCE(e.model,u.model,'unknown')
    ORDER BY provider,model
  `);
  return {
    from: input.from,
    to: input.to,
    rows: rows.map(
      (row): CreditCostReportRow => ({
        provider: row.provider,
        model: row.model,
        providerCostUsd: row.providerCostUsd,
        chargedMicros: row.chargedMicros.toString(),
        pendingMicros: row.pendingMicros.toString(),
        knownCostCount: Number(row.knownCostCount),
        unknownCostCount: Number(row.unknownCostCount),
        pendingCount: Number(row.pendingCount),
      }),
    ),
  };
}

export function createHostedCreditServices(deps: Pick<RouterDeps, "prisma" | "env">) {
  const { prisma } = deps;
  async function organization(actor: Actor) {
    const found = await organizationForMember(prisma, actor);
    if (!found) throw new ORPCError("FORBIDDEN");
    return found.organizationId;
  }
  /** Check verified deployment authorization before entering the cross-tenant scope. */
  async function operator<T>(actor: Actor, task: () => Promise<T>): Promise<T> {
    if (!(await isAdmin(deps, actor.userId))) throw new ORPCError("FORBIDDEN");
    return runAsSystem("deployment operator hosted credit management", task);
  }
  async function mutation<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      // Database/constraint messages can carry private row data. Only expose defined input errors.
      if (error instanceof Error && /idempotency|already used/i.test(error.message))
        throw new ORPCError("CONFLICT", {
          message: "This request key was already used for a different change",
        });
      if (
        error instanceof Error &&
        /insufficient|negative|balance|exceeds available/i.test(error.message)
      )
        throw new ORPCError("BAD_REQUEST", {
          message: "The correction exceeds the available credits",
        });
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["P2003", "P2025"].includes(String(error.code))
      )
        throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
      throw error;
    }
  }
  return {
    async status(actor: Actor) {
      return hostedCreditStatus(prisma, await organization(actor));
    },
    async selectFunding(actor: Actor, funding: "credits" | "byok") {
      const policy = await getHostedCreditPolicy(prisma);
      if (!policy.enabled && policy.activatedAt === null) throw new ORPCError("NOT_FOUND");
      if (!policy.enabled && funding === "credits")
        throw new ORPCError("PRECONDITION_FAILED", { message: "Hosted model credits are paused" });
      const found = await organizationForMember(prisma, actor);
      if (!found?.isOwner) throw new ORPCError("FORBIDDEN");
      await creditAccount(prisma, found.organizationId);
      await prisma.modelCreditAccount.update({
        where: { organizationId: found.organizationId },
        data: { mode: funding },
      });
      if (funding === "credits") await hostedCreditStatus(prisma, found.organizationId);
      return { ok: true as const };
    },
    async billingStatus(actor: Actor): Promise<BillingStatus> {
      const policy = await getHostedCreditPolicy(prisma);
      if (!policy.enabled && policy.activatedAt === null) throw new ORPCError("NOT_FOUND");
      const found = await organizationForMember(prisma, actor);
      if (!found) throw new ORPCError("FORBIDDEN");
      const hosted = await hostedCreditStatus(prisma, found.organizationId);
      const account = await creditAccount(prisma, found.organizationId);
      return {
        funding: account.mode === "byok" ? "byok" : "credits",
        balanceUsd: Number(hosted.balanceMicros) / 1_000_000,
        creditPurchasesEnabled: false,
        byokPriceCents: null,
        access: account.mode === "byok" || (policy.enabled && BigInt(hosted.balanceMicros) > 0n),
        canManage: found.isOwner,
        trialAvailable: false,
        trialDays: 0,
        state: "none",
        price: null,
        seats: 1,
        trialEndsAt: null,
        currentPeriodEndsAt: null,
        cancelAtPeriodEnd: false,
        hasCustomer: false,
      };
    },
    async publicTariffs() {
      const policy = await getHostedCreditPolicy(prisma);
      if (!policy.enabled) return [];
      return (await listHostedCreditTariffs(prisma)).map(({ provider, model, multiplierBps }) => ({
        provider,
        model,
        multiplierBps,
      }));
    },
    overview: (actor: Actor) =>
      operator(actor, async () => {
        const [summary] = await prisma.$queryRaw<
          Array<{
            accountCount: bigint;
            balanceMicros: bigint;
            pendingCount: bigint;
            pendingMicros: bigint;
          }>
        >`
          SELECT
            (SELECT COUNT(*) FROM model_credit_accounts) AS "accountCount",
            (SELECT COALESCE(SUM("balanceMicros"),0) FROM model_credit_accounts)
              -(SELECT COALESCE(SUM("availableMicros"),0) FROM model_credit_lots
                WHERE "expiresAt"<=${new Date()} AND "availableMicros">0) AS "balanceMicros",
            (SELECT COUNT(*) FROM model_credit_entries WHERE pending) AS "pendingCount",
            (SELECT COALESCE(SUM(-"amountMicros"),0) FROM model_credit_entries WHERE pending) AS "pendingMicros"
        `;
        return {
          accountCount: Number(summary!.accountCount),
          balanceMicros: summary!.balanceMicros.toString(),
          pendingCount: Number(summary!.pendingCount),
          pendingMicros: summary!.pendingMicros.toString(),
        };
      }),
    accounts: (actor: Actor, input: { query?: string; cursor?: string; limit: number }) =>
      operator(actor, async () => {
        const rows = await prisma.$queryRaw<
          Array<{
            id: string;
            name: string;
            mode: string | null;
            balanceMicros: bigint;
            dailyAllowanceMicros: bigint | null;
          }>
        >(Prisma.sql`
          WITH page AS (
            SELECT id,name FROM organization
            WHERE true ${input.cursor ? Prisma.sql`AND id>${input.cursor}` : Prisma.empty}
              ${input.query ? Prisma.sql`AND (position(${input.query} in id)>0 OR position(lower(${input.query}) in lower(name))>0)` : Prisma.empty}
            ORDER BY id LIMIT ${input.limit + 1}
          )
          SELECT p.id,p.name,a.mode,a."dailyAllowanceMicros",
            COALESCE(a."balanceMicros",0)-COALESCE((
              SELECT SUM(l."availableMicros") FROM model_credit_lots l
              WHERE l."organizationId"=p.id AND l."expiresAt"<=${new Date()} AND l."availableMicros">0
            ),0) AS "balanceMicros"
          FROM page p LEFT JOIN model_credit_accounts a ON a."organizationId"=p.id ORDER BY p.id
        `);
        const page = rows.slice(0, input.limit);
        return {
          accounts: page.map((row) => ({
            organizationId: row.id,
            name: row.name,
            mode: row.mode,
            balanceMicros: row.balanceMicros.toString(),
            dailyAllowanceMicros: row.dailyAllowanceMicros?.toString() ?? null,
          })),
          nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
        };
      }),
    journal: (actor: Actor, input: { organizationId?: string; cursor?: string; limit: number }) =>
      operator(actor, async () => {
        // Opaque ID cursor is resolved only inside this authorized scope and optional account filter.
        const anchor = input.cursor
          ? await prisma.billingAuditEvent.findFirst({
              where: {
                id: input.cursor,
                ...(input.organizationId ? { organizationId: input.organizationId } : {}),
              },
              select: { createdAt: true, id: true },
            })
          : null;
        if (input.cursor && !anchor)
          throw new ORPCError("BAD_REQUEST", { message: "Invalid journal cursor" });
        const rows = await prisma.billingAuditEvent.findMany({
          where: {
            ...(input.organizationId ? { organizationId: input.organizationId } : {}),
            ...(anchor
              ? {
                  OR: [
                    { createdAt: { lt: anchor.createdAt } },
                    { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
        });
        const page = rows.slice(0, input.limit);
        return {
          events: page.map(journalDto),
          nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
        };
      }),
    policy: (actor: Actor) =>
      operator(actor, async () => policyDto(await getHostedCreditPolicy(prisma))),
    updatePolicy: (
      actor: Actor,
      input: {
        enabled: boolean;
        defaultDailyAllowanceMicros: string;
        dailyGrantBudgetMicros: string;
        reason: string;
        idempotencyKey: string;
      },
    ) =>
      operator(actor, () =>
        mutation(async () => {
          await updateHostedCreditPolicy(prisma, {
            ...input,
            defaultDailyAllowanceMicros: BigInt(input.defaultDailyAllowanceMicros),
            dailyGrantBudgetMicros: BigInt(input.dailyGrantBudgetMicros),
            actorId: actor.userId,
          });
          return policyDto(await getHostedCreditPolicy(prisma));
        }),
      ),
    tariffs: (actor: Actor) =>
      operator(actor, async () =>
        (await listHostedCreditTariffs(prisma)).map(({ provider, model, multiplierBps }) => ({
          provider,
          model,
          multiplierBps,
        })),
      ),
    updateTariff: (
      actor: Actor,
      input: {
        provider: string;
        model: string;
        multiplierBps: number;
        reason: string;
        idempotencyKey: string;
      },
    ) =>
      operator(actor, () =>
        mutation(async () => {
          await setHostedCreditTariff(prisma, { ...input, actorId: actor.userId });
          const row = (await listHostedCreditTariffs(prisma)).find(
            (row) => row.provider === input.provider && row.model === input.model,
          )!;
          return { provider: row.provider, model: row.model, multiplierBps: row.multiplierBps };
        }),
      ),
    adjustment: (
      actor: Actor,
      input: {
        organizationId: string;
        amountMicros: string;
        reason: string;
        idempotencyKey: string;
      },
    ) =>
      operator(actor, () =>
        mutation(async () => {
          await adjustModelCredits(prisma, {
            ...input,
            amountMicros: BigInt(input.amountMicros),
            actorId: actor.userId,
          });
          return { ok: true as const };
        }),
      ),
    updateAllowance: (
      actor: Actor,
      input: {
        organizationId: string;
        dailyAllowanceMicros: string | null;
        reason: string;
        idempotencyKey: string;
      },
    ) =>
      operator(actor, () =>
        mutation(async () => {
          await setHostedCreditAllowance(prisma, {
            ...input,
            dailyAllowanceMicros:
              input.dailyAllowanceMicros === null ? null : BigInt(input.dailyAllowanceMicros),
            actorId: actor.userId,
          });
          return { ok: true as const };
        }),
      ),
    costReport: (actor: Actor, input: CreditCostReportInput) =>
      operator(actor, () => hostedCostReport(prisma, input)),
  };
}
