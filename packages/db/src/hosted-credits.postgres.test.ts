import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  adjustModelCredits,
  getHostedCreditPolicy,
  grantDailyModelCredits,
  hostedCreditStatus,
  hostedModelMeteringEnabled,
  setHostedCreditAllowance,
  setHostedCreditTariff,
  updateHostedCreditPolicy,
} from "./hosted-credits.js";
import {
  creditAccount,
  expireModelCredits,
  reserveModelCredits,
  settleModelCredits,
  settleModelCreditsTx,
} from "./model-credits.js";
import { asSystem } from "./row-security.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
dbTests("hosted credit administration", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let organizationId: string;
  let userId: string;
  let now: Date;
  let tomorrow: Date;
  let day = 0;
  const operator = () => ({
    actorId: "fixture-operator",
    reason: "Reviewed adjustment",
    idempotencyKey: crypto.randomUUID(),
  });
  const balance = async () => (await creditAccount(prisma, organizationId)).balanceMicros;
  const grant = (amountMicros = 10_000_000n, expiresAt?: Date) =>
    adjustModelCredits(
      prisma,
      {
        ...operator(),
        organizationId,
        amountMicros,
        expiresAt,
      },
      now,
    );
  const policy = (daily = 0n, budget = 0n) =>
    updateHostedCreditPolicy(prisma, {
      ...operator(),
      enabled: true,
      defaultDailyAllowanceMicros: daily,
      dailyGrantBudgetMicros: budget,
    });
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });
  beforeEach(async () => {
    now = new Date(Date.UTC(2030, 0, ++day, 12));
    tomorrow = new Date(Date.UTC(2030, 0, day + 1));
    userId = crypto.randomUUID();
    organizationId = `hosted-test-${crypto.randomUUID()}`;
    await prisma.hostedCreditPolicy.update({
      where: { id: "deployment" },
      data: {
        enabled: false,
        activatedAt: null,
        defaultDailyAllowanceMicros: 0n,
        dailyGrantBudgetMicros: 0n,
      },
    });
    await prisma.hostedCreditTariff.deleteMany();
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@rakazo.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Fixture",
        slug: `user-${userId.slice(0, 12)}`,
        createdAt: now,
      },
    });
    await prisma.member.create({
      data: { id: crypto.randomUUID(), organizationId, userId, role: "owner", createdAt: now },
    });
    await creditAccount(prisma, organizationId);
  });
  afterEach(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("defaults to no hosted access and no free grant", async () => {
    await expect(grantDailyModelCredits(prisma, organizationId, now)).resolves.toBe(0n);
    expect(await balance()).toBe(0n);
    await expect(reserveModelCredits(prisma, organizationId, 0.1, undefined, now)).rejects.toThrow(
      "Not enough",
    );
    await policy(1000n, 0n);
    await expect(grantDailyModelCredits(prisma, organizationId, now)).resolves.toBe(0n);
  });

  it("atomically replays manual grants once and preserves actor and reason in the journal", async () => {
    const input = { ...operator(), organizationId, amountMicros: 100_000n };
    const entries = await Promise.all(
      Array.from({ length: 4 }, () => adjustModelCredits(prisma, input, now)),
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(1);
    expect(await balance()).toBe(100_000n);
    const receipt = await prisma.billingAuditEvent.findFirstOrThrow({
      where: { organizationId, kind: "manual_adjustment" },
    });
    expect(receipt.amountMicros).toBe(100_000n);
    expect(receipt.details).toMatchObject({
      entry: { actorId: input.actorId, reason: input.reason },
    });
    await expect(
      adjustModelCredits(prisma, { ...input, amountMicros: 200_000n }, now),
    ).rejects.toThrow("Idempotency");
    expect(await balance()).toBe(100_000n);
  });

  it("does not let concurrent negative corrections consume held funds", async () => {
    await policy();
    await grant();
    const call = await reserveModelCredits(prisma, organizationId, 8, undefined, now);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        adjustModelCredits(
          prisma,
          {
            ...operator(),
            organizationId,
            amountMicros: -1_500_000n,
          },
          now,
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(500_000n);
    await settleModelCredits(prisma, call, 3, now);
    expect(await balance()).toBe(5_500_000n);
  });

  it("cannot debit expired grants or revive an expired replay or hold refund", async () => {
    await policy();
    const input = { ...operator(), organizationId, amountMicros: 10_000_000n, expiresAt: tomorrow };
    await adjustModelCredits(prisma, input, now);
    const call = await reserveModelCredits(prisma, organizationId, 8, undefined, now);
    await expireModelCredits(prisma, organizationId, tomorrow);
    await expect(
      adjustModelCredits(prisma, { ...operator(), organizationId, amountMicros: -1n }, tomorrow),
    ).rejects.toThrow("exceeds");
    await adjustModelCredits(prisma, input, tomorrow);
    await settleModelCredits(prisma, call, 3, tomorrow);
    expect(await balance()).toBe(0n);
  });

  it("freezes a model-specific tariff through settlement and later provider corrections", async () => {
    await policy();
    await grant();
    const model = { provider: "fixture-provider", model: "fixture-model" };
    await setHostedCreditTariff(prisma, { ...operator(), ...model, multiplierBps: 20_000 });
    const call = await reserveModelCredits(prisma, organizationId, 3, model, now);
    expect(await balance()).toBe(4_000_000n);
    await setHostedCreditTariff(prisma, { ...operator(), ...model, multiplierBps: 50_000 });
    await settleModelCredits(prisma, call, 0.5, now);
    expect(await balance()).toBe(9_000_000n);
    await prisma.$transaction((tx) => settleModelCreditsTx(tx, call, 0.75, true, now));
    expect(await balance()).toBe(8_500_000n);
    expect(await prisma.modelCreditEntry.findUniqueOrThrow({ where: { id: call } })).toMatchObject({
      multiplierBps: 20_000,
      providerCostMicros: 750_000n,
      amountMicros: -1_500_000n,
    });
  });

  it("does not assign provider cost to unknown holds or apply new tariffs to legacy calls", async () => {
    await prisma.modelCreditAccount.update({
      where: { organizationId },
      data: { mode: "credits" },
    });
    await grant();
    const call = await reserveModelCredits(prisma, organizationId, 1, undefined, now);
    await settleModelCredits(prisma, call, null, now);
    expect(await prisma.modelCreditEntry.findUniqueOrThrow({ where: { id: call } })).toMatchObject({
      pending: true,
      providerCostMicros: null,
    });
    await setHostedCreditTariff(prisma, {
      ...operator(),
      provider: "fixture-provider",
      model: "fixture-model",
      multiplierBps: 30_000,
    });
    await settleModelCredits(prisma, call, 0.5, now);
    expect(await balance()).toBe(9_500_000n);
  });

  it("issues one expiring daily grant under concurrency without replenishing on same-day config changes", async () => {
    await policy(1_000_000n, 2_000_000n);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => grantDailyModelCredits(prisma, organizationId, now)),
    );
    expect(results.reduce((sum, value) => sum + value, 0n)).toBe(1_000_000n);
    await setHostedCreditAllowance(prisma, {
      ...operator(),
      organizationId,
      dailyAllowanceMicros: 2_000_000n,
    });
    await grantDailyModelCredits(prisma, organizationId, now);
    expect(await balance()).toBe(1_000_000n);
    await grantDailyModelCredits(prisma, organizationId, tomorrow);
    expect(await balance()).toBe(2_000_000n);
    expect(await hostedCreditStatus(prisma, organizationId, tomorrow)).toMatchObject({
      dailyGrantedMicros: "2000000",
      balanceMicros: "2000000",
      nextGrantAt: new Date(tomorrow.getTime() + 86_400_000).toISOString(),
    });
  });

  it("cannot farm a daily allowance from a second organization or an unverified owner", async () => {
    await policy(1_000_000n, 10_000_000n);
    const other = `other-${crypto.randomUUID()}`;
    await prisma.organization.create({
      data: { id: other, name: "Other", slug: other, createdAt: now },
    });
    try {
      await prisma.member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: other,
          userId,
          role: "owner",
          createdAt: now,
        },
      });
      expect(await grantDailyModelCredits(prisma, other, now)).toBe(0n);
      await prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });
      expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(0n);
      await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
      expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(1_000_000n);
    } finally {
      await prisma.organization.delete({ where: { id: other } });
    }
  });

  it("enforces the shared daily budget and a zero allowance override", async () => {
    await policy(1_000_000n, 500_000n);
    expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(0n);
    await policy(1_000_000n, 2_000_000n);
    await setHostedCreditAllowance(prisma, {
      ...operator(),
      organizationId,
      dailyAllowanceMicros: 0n,
    });
    expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(0n);
    await setHostedCreditAllowance(prisma, {
      ...operator(),
      organizationId,
      dailyAllowanceMicros: null,
    });
    expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(1_000_000n);
  });

  it("keeps beneficiary and budget receipts after organization deletion and recreation", async () => {
    await policy(1_000_000n, 1_000_000n);
    expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(1_000_000n);
    await prisma.organization.delete({ where: { id: organizationId } });
    organizationId = `recreated-${crypto.randomUUID()}`;
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Recreated",
        slug: `user-${userId.slice(0, 12)}`,
        createdAt: now,
      },
    });
    await prisma.member.create({
      data: { id: crypto.randomUUID(), organizationId, userId, role: "owner", createdAt: now },
    });
    expect(await grantDailyModelCredits(prisma, organizationId, now)).toBe(0n);
    const otherUser = crypto.randomUUID();
    const otherOrg = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: otherUser,
        name: "Other",
        email: `${otherUser}@rakazo.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: otherOrg, name: "Other", slug: `user-${otherUser.slice(0, 12)}`, createdAt: now },
    });
    try {
      await prisma.member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: otherOrg,
          userId: otherUser,
          role: "owner",
          createdAt: now,
        },
      });
      expect(await grantDailyModelCredits(prisma, otherOrg, now)).toBe(0n);
    } finally {
      await prisma.organization.delete({ where: { id: otherOrg } });
      await prisma.user.delete({ where: { id: otherUser } });
    }
  });

  it("serializes the deployment grant budget across concurrent eligible accounts", async () => {
    await policy(1_000_000n, 1_000_000n);
    const otherUser = crypto.randomUUID();
    const otherOrg = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: otherUser,
        name: "Other",
        email: `${otherUser}@rakazo.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: otherOrg, name: "Other", slug: `user-${otherUser.slice(0, 12)}`, createdAt: now },
    });
    try {
      await prisma.member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: otherOrg,
          userId: otherUser,
          role: "owner",
          createdAt: now,
        },
      });
      const results = await Promise.all([
        grantDailyModelCredits(prisma, organizationId, now),
        grantDailyModelCredits(prisma, otherOrg, now),
      ]);
      expect(results.filter((amount) => amount > 0n)).toHaveLength(1);
      expect(results.reduce((sum, amount) => sum + amount, 0n)).toBe(1_000_000n);
    } finally {
      await prisma.organization.delete({ where: { id: otherOrg } });
      await prisma.user.delete({ where: { id: otherUser } });
    }
  });

  it("replays audited operator changes through persisted JSONB and rejects changed inputs", async () => {
    const input = {
      ...operator(),
      enabled: true,
      defaultDailyAllowanceMicros: 123n,
      dailyGrantBudgetMicros: 456n,
    };
    await updateHostedCreditPolicy(prisma, input);
    await updateHostedCreditPolicy(prisma, input);
    expect((await getHostedCreditPolicy(prisma)).defaultDailyAllowanceMicros).toBe(123n);
    expect(
      await prisma.billingAuditEvent.count({
        where: { source: `hosted-admin:${input.idempotencyKey}` },
      }),
    ).toBe(1);
    await expect(updateHostedCreditPolicy(prisma, { ...input, enabled: false })).rejects.toThrow(
      "Idempotency",
    );
    await expect(
      setHostedCreditTariff(prisma, {
        ...input,
        provider: "fixture",
        model: "fixture",
        multiplierBps: 10_000,
      }),
    ).rejects.toThrow("Idempotency");
  });

  it("disabling a previously activated policy cannot restore unmetered hosted credentials", async () => {
    await policy();
    await grant();
    await updateHostedCreditPolicy(prisma, {
      ...operator(),
      enabled: false,
      defaultDailyAllowanceMicros: 0n,
      dailyGrantBudgetMicros: 0n,
    });
    expect(await hostedModelMeteringEnabled(prisma)).toBe(true);
    await expect(reserveModelCredits(prisma, organizationId, 1, undefined, now)).rejects.toThrow(
      "disabled",
    );
    expect(await balance()).toBe(10_000_000n);
  });
});
