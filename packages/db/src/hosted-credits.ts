import { isDeepStrictEqual } from "node:util";
import type { HostedCreditStatus } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  allocateCreditLots,
  allocatedMicros,
  expireCreditLots,
  prepareCreditLots,
  syncLotBalance,
} from "./model-credit-lots.js";
import { creditAccount } from "./model-credits.js";
import { runAsSystem } from "./row-security.js";

type Operator = { actorId: string; reason: string; idempotencyKey: string };
type Tx = Prisma.TransactionClient;
const MAX_MICROS = 9_000_000_000_000_000n;
const DEPLOYMENT = "deployment";
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
  );

function validateOperator(input: Operator) {
  if (
    !input.actorId.trim() ||
    input.actorId.length > 256 ||
    !input.reason.trim() ||
    input.reason.length > 500 ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey)
  )
    throw new Error("An actor, reason, and valid idempotency key are required");
}
function validateMicros(value: bigint, signed = false) {
  if (typeof value !== "bigint" || value > MAX_MICROS || value < (signed ? -MAX_MICROS : 0n))
    throw new Error("Invalid credit amount");
}
function utcDay(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid grant date");
  return now.toISOString().slice(0, 10);
}
const nextDay = (now: Date) => new Date(`${utcDay(now)}T00:00:00.000Z`).getTime() + 86_400_000;

export async function getHostedCreditPolicy(prisma: PrismaClient) {
  return prisma.hostedCreditPolicy.findUniqueOrThrow({ where: { id: DEPLOYMENT } });
}

/** Preserve paid metering and keep activation sticky so suspension cannot fail open. */
export async function hostedModelMeteringEnabled(prisma: PrismaClient) {
  const [policy, settings] = await Promise.all([
    getHostedCreditPolicy(prisma),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    }),
  ]);
  return policy.enabled || policy.activatedAt !== null || settings?.modelCreditsEnabled === true;
}

/** Operator authorization belongs to the API. Every accepted change has an immutable receipt. */
async function operatorChange<T>(
  prisma: PrismaClient,
  kind: string,
  input: Operator & object,
  change: (tx: Tx) => Promise<{ previous: unknown; current: T }>,
) {
  validateOperator(input);
  return runAsSystem("audit hosted-credit operator configuration", () =>
    prisma.$transaction(async (tx) => {
      // The same lock coordinates daily grants, budget edits, and operator request replays.
      await tx.$queryRaw`SELECT id FROM hosted_credit_policies WHERE id=${DEPLOYMENT} FOR UPDATE`;
      const source = `hosted-admin:${input.idempotencyKey}`;
      const receipt = await tx.billingAuditEvent.findUnique({ where: { source } });
      const requested = json(input);
      if (receipt) {
        const details = receipt.details as { input?: unknown; current: T };
        if (receipt.kind !== kind || !isDeepStrictEqual(details.input, requested))
          throw new Error("Idempotency key was already used for a different change");
        return;
      }
      const { previous, current } = await change(tx);
      await tx.billingAuditEvent.create({
        data: {
          source,
          kind,
          organizationId: "organizationId" in input ? String(input.organizationId) : null,
          details: json({
            actorId: input.actorId,
            reason: input.reason,
            input: requested,
            previous,
            current,
          }),
        },
      });
      return;
    }),
  );
}

export function updateHostedCreditPolicy(
  prisma: PrismaClient,
  input: Operator & {
    enabled: boolean;
    defaultDailyAllowanceMicros: bigint;
    dailyGrantBudgetMicros: bigint;
  },
) {
  validateMicros(input.defaultDailyAllowanceMicros);
  validateMicros(input.dailyGrantBudgetMicros);
  return operatorChange(prisma, "hosted_policy", input, async (tx) => {
    const previous = await tx.hostedCreditPolicy.findUniqueOrThrow({ where: { id: DEPLOYMENT } });
    return {
      previous,
      current: await tx.hostedCreditPolicy.update({
        where: { id: DEPLOYMENT },
        data: {
          enabled: input.enabled,
          activatedAt: previous.activatedAt ?? (input.enabled ? new Date() : null),
          defaultDailyAllowanceMicros: input.defaultDailyAllowanceMicros,
          dailyGrantBudgetMicros: input.dailyGrantBudgetMicros,
        },
      }),
    };
  });
}

export function listHostedCreditTariffs(prisma: PrismaClient) {
  return prisma.hostedCreditTariff.findMany({ orderBy: [{ provider: "asc" }, { model: "asc" }] });
}

export function setHostedCreditTariff(
  prisma: PrismaClient,
  input: Operator & {
    provider: string;
    model: string;
    multiplierBps: number;
  },
) {
  if (
    !input.provider.trim() ||
    input.provider.length > 128 ||
    !input.model.trim() ||
    input.model.length > 256 ||
    !Number.isInteger(input.multiplierBps) ||
    input.multiplierBps < 1 ||
    input.multiplierBps > 1_000_000
  )
    throw new Error("Invalid hosted model tariff");
  const { provider, model, multiplierBps } = input;
  return operatorChange(prisma, "hosted_tariff", input, async (tx) => ({
    previous: await tx.hostedCreditTariff.findUnique({
      where: { provider_model: { provider, model } },
    }),
    current: await tx.hostedCreditTariff.upsert({
      where: { provider_model: { provider, model } },
      create: { provider, model, multiplierBps },
      update: { multiplierBps },
    }),
  }));
}

export async function setHostedCreditAllowance(
  prisma: PrismaClient,
  input: Operator & {
    organizationId: string;
    dailyAllowanceMicros: bigint | null;
  },
) {
  if (input.dailyAllowanceMicros !== null) validateMicros(input.dailyAllowanceMicros);
  await creditAccount(prisma, input.organizationId);
  return operatorChange(prisma, "hosted_allowance", input, async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${input.organizationId} FOR UPDATE`;
    return {
      previous: await tx.modelCreditAccount.findUniqueOrThrow({
        where: { organizationId: input.organizationId },
      }),
      current: await tx.modelCreditAccount.update({
        where: { organizationId: input.organizationId },
        data: { dailyAllowanceMicros: input.dailyAllowanceMicros },
      }),
    };
  });
}

/** Corrections only consume available lots; reservations keep their original funding and expiry. */
export async function adjustModelCredits(
  prisma: PrismaClient,
  input: Operator & {
    organizationId: string;
    amountMicros: bigint;
    expiresAt?: Date;
  },
  now = new Date(),
) {
  validateOperator(input);
  validateMicros(input.amountMicros, true);
  if (input.amountMicros === 0n) throw new Error("A credit adjustment cannot be zero");
  if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.amountMicros < 0n))
    throw new Error("Invalid credit adjustment expiration");
  await creditAccount(prisma, input.organizationId);
  return prisma.$transaction(async (tx) => {
    const { organizationId, amountMicros, actorId, reason } = input;
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
    const source = `adjustment:${organizationId}:${input.idempotencyKey}`;
    const existing = await tx.modelCreditEntry.findUnique({ where: { source } });
    if (existing) {
      const lot = await tx.modelCreditLot.findUnique({ where: { id: existing.id } });
      if (
        existing.amountMicros !== amountMicros ||
        existing.actorId !== actorId ||
        existing.reason !== reason ||
        (lot?.expiresAt?.getTime() ?? null) !== (input.expiresAt?.getTime() ?? null)
      )
        throw new Error("Idempotency key was already used for a different adjustment");
      return existing;
    }
    if (input.expiresAt && input.expiresAt <= now)
      throw new Error("Invalid credit adjustment expiration");
    await prepareCreditLots(tx, organizationId, now);
    await expireCreditLots(tx, organizationId, now);
    const account = await tx.modelCreditAccount.findUniqueOrThrow({ where: { organizationId } });
    if (amountMicros < 0n && account.balanceMicros < -amountMicros)
      throw new Error("Adjustment exceeds available model credits");
    const allocations =
      amountMicros < 0n ? await allocateCreditLots(tx, organizationId, -amountMicros, now) : [];
    const entry = await tx.modelCreditEntry.create({
      data: {
        source,
        organizationId,
        amountMicros,
        actorId,
        reason,
        allocations,
        fundedMicros: allocatedMicros(allocations),
      },
    });
    await tx.modelCreditAccount.update({
      where: { organizationId },
      data: { balanceMicros: { increment: amountMicros } },
    });
    if (amountMicros > 0n)
      await tx.modelCreditLot.create({
        data: {
          id: entry.id,
          organizationId,
          amountMicros,
          availableMicros: amountMicros,
          expiresAt: input.expiresAt,
        },
      });
    await syncLotBalance(tx, organizationId);
    return entry;
  });
}

/** Bootstrap owns this canonical slug. Arbitrary memberships never create subsidized identities. */
async function dailyGrantBeneficiary(tx: Tx, organizationId: string) {
  const eligible = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT u.id FROM organization o JOIN member m ON m."organizationId"=o.id
    JOIN "user" u ON u.id=m."userId"
    WHERE o.id=${organizationId} AND m.role='owner' AND u."emailVerified"=true
      AND o.slug='user-' || left(u.id,12) LIMIT 1`;
  return eligible[0]?.id ?? null;
}

/** At most one expiring grant per canonical verified personal organization per UTC day. */
export async function grantDailyModelCredits(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
) {
  const day = utcDay(now);
  await creditAccount(prisma, organizationId);
  // Avoid a deployment-wide lock when subsidies are disabled (the default).
  const configured = await getHostedCreditPolicy(prisma);
  if (!configured.enabled || configured.dailyGrantBudgetMicros === 0n) return 0n;
  if (
    await prisma.modelCreditEntry.findUnique({
      where: { source: `daily:${organizationId}:${day}` },
    })
  )
    return 0n;
  return runAsSystem("issue and audit a budgeted hosted-credit daily grant", () =>
    prisma.$transaction(async (tx) => {
      // Serializes just the scarce deployment grant budget, not model calls or provider work.
      await tx.$queryRaw`SELECT id FROM hosted_credit_policies WHERE id=${DEPLOYMENT} FOR UPDATE`;
      const policy = await tx.hostedCreditPolicy.findUniqueOrThrow({ where: { id: DEPLOYMENT } });
      if (!policy.enabled || policy.dailyGrantBudgetMicros === 0n) return 0n;
      await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
      const account = await tx.modelCreditAccount.findUniqueOrThrow({ where: { organizationId } });
      if (account.mode === "byok") return 0n;
      const beneficiaryId = await dailyGrantBeneficiary(tx, organizationId);
      if (!beneficiaryId) return 0n;
      const allowance = account.dailyAllowanceMicros ?? policy.defaultDailyAllowanceMicros;
      if (allowance === 0n) return 0n;
      const source = `daily:${organizationId}:${day}`;
      if (await tx.modelCreditEntry.findUnique({ where: { source } })) return 0n;
      const beneficiarySource = `daily-beneficiary:${beneficiaryId}:${day}`;
      if (await tx.billingAuditEvent.findUnique({ where: { source: beneficiarySource } }))
        return 0n;
      // Immutable receipts survive account deletion, preserving both identity and deployment budget.
      const [granted] = await tx.$queryRaw<Array<{ amountMicros: bigint }>>`
      SELECT COALESCE(SUM((details->>'amountMicros')::bigint),0)::bigint AS "amountMicros"
      FROM billing_audit_events WHERE kind='daily_grant_issued' AND details->>'grantDay'=${day}`;
      // All-or-nothing grants make budget exhaustion independent of partial allowance replays.
      if ((granted?.amountMicros ?? 0n) + allowance > policy.dailyGrantBudgetMicros) return 0n;
      await prepareCreditLots(tx, organizationId, now);
      await expireCreditLots(tx, organizationId, now);
      const entry = await tx.modelCreditEntry.create({
        data: {
          source,
          organizationId,
          amountMicros: allowance,
          grantDay: day,
          reason: "Daily hosted model allowance",
        },
      });
      await tx.billingAuditEvent.create({
        data: {
          source: beneficiarySource,
          kind: "daily_grant_issued",
          organizationId,
          userId: beneficiaryId,
          details: json({
            beneficiaryId,
            grantDay: day,
            amountMicros: allowance,
            entryId: entry.id,
          }),
        },
      });
      await tx.modelCreditLot.create({
        data: {
          id: entry.id,
          organizationId,
          amountMicros: allowance,
          availableMicros: allowance,
          expiresAt: new Date(nextDay(now)),
        },
      });
      await tx.modelCreditAccount.update({
        where: { organizationId },
        data: { balanceMicros: { increment: allowance } },
      });
      await syncLotBalance(tx, organizationId);
      return allowance;
    }),
  );
}

export async function hostedCreditStatus(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
): Promise<HostedCreditStatus> {
  await grantDailyModelCredits(prisma, organizationId, now);
  const policy = await getHostedCreditPolicy(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
    await prepareCreditLots(tx, organizationId, now);
    await expireCreditLots(tx, organizationId, now);
    const account = await tx.modelCreditAccount.findUniqueOrThrow({ where: { organizationId } });
    const enabled = policy.enabled && account.mode !== "byok";
    const eligible = enabled && (await dailyGrantBeneficiary(tx, organizationId));
    const allowance = eligible
      ? (account.dailyAllowanceMicros ?? policy.defaultDailyAllowanceMicros)
      : 0n;
    const entry = await tx.modelCreditEntry.findUnique({
      where: { source: `daily:${organizationId}:${utcDay(now)}` },
    });
    return {
      available: policy.enabled,
      enabled,
      balanceMicros: account.balanceMicros.toString(),
      dailyAllowanceMicros: allowance.toString(),
      dailyGrantedMicros: (entry?.amountMicros ?? 0n).toString(),
      nextGrantAt:
        allowance > 0n && policy.dailyGrantBudgetMicros > 0n
          ? new Date(nextDay(now)).toISOString()
          : null,
    };
  });
}
