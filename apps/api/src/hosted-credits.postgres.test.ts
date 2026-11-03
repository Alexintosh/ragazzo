import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedCreditServices } from "./hosted-credits.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
dbTests("hosted credit operator API", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const operatorId = `operator-${stamp}`,
    ownerId = `owner-${stamp}`;
  const organizationId = `hosted-org-${stamp}`,
    otherOrgId = `hosted-other-${stamp}`;
  const spaceId = `hosted-space-${stamp}`;
  const actor: Actor = {
    userId: operatorId,
    spaceId,
    email: `operator-${stamp}@example.test`,
    isDeploymentOwner: false,
  };
  let db: ReturnType<typeof createDb>,
    prisma: PrismaClient,
    service: ReturnType<typeof createHostedCreditServices>;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    await prisma.user.createMany({
      data: [
        { id: operatorId, name: "Fixture operator", email: actor.email, emailVerified: true },
        {
          id: ownerId,
          name: "Fixture owner",
          email: `owner-${stamp}@example.test`,
          emailVerified: true,
        },
      ],
    });
    for (const id of [organizationId, otherOrgId]) {
      await prisma.organization.create({
        data: { id, name: "Fixture organization", slug: id, createdAt: new Date() },
      });
      await prisma.modelCreditAccount.create({ data: { organizationId: id, mode: "credits" } });
    }
    await prisma.space.create({
      data: { id: spaceId, name: "Fixture space", organizationId, isDefault: true },
    });
    await prisma.member.createMany({
      data: [
        {
          id: `operator-member-${stamp}`,
          organizationId,
          userId: operatorId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: `owner-member-${stamp}`,
          organizationId,
          userId: ownerId,
          role: "owner",
          createdAt: new Date(),
        },
      ],
    });
    // The member trigger adds both users to the organization's default space.
    service = createHostedCreditServices({
      prisma: db.prisma,
      env: { adminEmails: [actor.email] } as never,
    });
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, otherOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [operatorId, ownerId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it("allows only the deployment operator to correct another organization, once, with attribution", async () => {
    const input = {
      organizationId: otherOrgId,
      amountMicros: "10000",
      reason: "Fixture correction",
      idempotencyKey: `correction_${stamp.replace(/-/g, "_")}`,
    };
    await expect(
      runAsTenant({ ...actor, userId: ownerId }, () =>
        service.adjustment({ ...actor, userId: ownerId }, input),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await runAsTenant(actor, () => service.adjustment(actor, input));
    await runAsTenant(actor, () => service.adjustment(actor, input));
    expect(
      (await prisma.modelCreditAccount.findUniqueOrThrow({ where: { organizationId: otherOrgId } }))
        .balanceMicros,
    ).toBe(10000n);
    await expect(
      runAsTenant(actor, () => service.adjustment(actor, { ...input, amountMicros: "20000" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const journal = await runAsTenant(actor, () =>
      service.journal(actor, { organizationId: otherOrgId, limit: 100 }),
    );
    expect(
      journal.events.some(
        (event) => event.reason === input.reason && event.actorId === actor.userId,
      ),
    ).toBe(true);
    expect(journal.events.every((event) => event.organizationId === otherOrgId)).toBe(true);
  });
  it("aggregates recorded provider cost separately from finalized charges and unknown holds, with UTC boundaries", async () => {
    const day = new Date("2026-01-02T00:00:00.000Z");
    const calls = [
      {
        id: `known-${stamp}`,
        organizationId,
        amountMicros: -2000n,
        pending: false,
        costUsd: 0.001,
        createdAt: day,
      },
      {
        id: `pending-${stamp}`,
        organizationId,
        amountMicros: -5000n,
        pending: true,
        costUsd: null,
        createdAt: day,
      },
      {
        id: `other-${stamp}`,
        organizationId: otherOrgId,
        amountMicros: -9000n,
        pending: false,
        costUsd: 0.004,
        createdAt: day,
      },
      {
        id: `excluded-${stamp}`,
        organizationId,
        amountMicros: -50000n,
        pending: false,
        costUsd: 0.01,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    ];
    for (const call of calls) {
      await prisma.modelCreditEntry.create({
        data: {
          id: call.id,
          callId: call.id,
          source: `call:${call.id}`,
          organizationId: call.organizationId,
          amountMicros: call.amountMicros,
          pending: call.pending,
          provider: "fixture-provider",
          model: "fixture-model",
          createdAt: call.createdAt,
        },
      });
      if (call.costUsd !== null)
        await prisma.usageRecord.create({
          data: {
            callId: call.id,
            spaceId,
            userId: operatorId,
            provider: "fixture-provider",
            model: "fixture-model",
            costUsd: call.costUsd,
            costSource: "provider-reported",
            createdAt: call.createdAt,
          },
        });
    }
    const report = await runAsTenant(actor, () =>
      service.costReport(actor, { from: "2026-01-02", to: "2026-01-03", organizationId }),
    );
    expect(report.rows).toEqual([
      {
        provider: "fixture-provider",
        model: "fixture-model",
        providerCostUsd: 0.001,
        chargedMicros: "2000",
        pendingMicros: "5000",
        knownCostCount: 1,
        unknownCostCount: 1,
        pendingCount: 1,
      },
    ]);
    const all = await runAsTenant(actor, () =>
      service.costReport(actor, { from: "2026-01-02", to: "2026-01-03" }),
    );
    expect(all.rows[0]).toMatchObject({
      providerCostUsd: 0.005,
      chargedMicros: "11000",
      pendingMicros: "5000",
      knownCostCount: 2,
    });
  });
  it("uses the latest immutable call and usage revisions without double-counting", async () => {
    await prisma.modelCreditEntry.update({
      where: { id: `known-${stamp}` },
      data: { amountMicros: -3000n },
    });
    await prisma.usageRecord.update({
      where: { callId: `known-${stamp}` },
      data: { costUsd: 0.0015 },
    });
    const report = await runAsTenant(actor, () =>
      service.costReport(actor, {
        from: "2026-01-02",
        to: "2026-01-03",
        organizationId,
      }),
    );
    expect(report.rows[0]).toMatchObject({
      providerCostUsd: 0.0015,
      chargedMicros: "3000",
      knownCostCount: 1,
      unknownCostCount: 1,
    });
  });
  it("shows spendable balances after an inactive account's credits expire, preserving held credits", async () => {
    const expiredOrgId = `expired-${stamp}`;
    const before = await runAsTenant(actor, () => service.overview(actor));
    await prisma.organization.create({
      data: {
        id: expiredOrgId,
        name: "Expired fixture",
        slug: expiredOrgId,
        createdAt: new Date(),
      },
    });
    try {
      await prisma.modelCreditAccount.create({
        data: { organizationId: expiredOrgId, mode: "credits", balanceMicros: 5000n },
      });
      await prisma.modelCreditLot.create({
        data: {
          id: `expired-lot-${stamp}`,
          organizationId: expiredOrgId,
          amountMicros: 10000n,
          availableMicros: 5000n,
          usedMicros: 5000n,
          expiresAt: new Date(Date.now() - 86_400_000),
        },
      });
      await prisma.modelCreditEntry.create({
        data: {
          source: `call:expired-${stamp}`,
          organizationId: expiredOrgId,
          amountMicros: -5000n,
          pending: true,
        },
      });
      const page = await runAsTenant(actor, () =>
        service.accounts(actor, { query: expiredOrgId, limit: 25 }),
      );
      expect(page.accounts).toEqual([
        expect.objectContaining({ organizationId: expiredOrgId, balanceMicros: "0" }),
      ]);
      const after = await runAsTenant(actor, () => service.overview(actor));
      expect(after.balanceMicros).toBe(before.balanceMicros);
      expect(BigInt(after.pendingMicros)).toBe(BigInt(before.pendingMicros) + 5000n);
      // A read does not settle or release the in-flight reservation.
      expect(
        (await prisma.modelCreditLot.findUniqueOrThrow({ where: { id: `expired-lot-${stamp}` } }))
          .usedMicros,
      ).toBe(5000n);
    } finally {
      await prisma.organization.delete({ where: { id: expiredOrgId } });
    }
  });
  it("retains historical provider costs and charged credits after an organization is deleted", async () => {
    const range = { from: "2026-01-02", to: "2026-01-03", organizationId: otherOrgId };
    const before = await runAsTenant(actor, () => service.costReport(actor, range));
    await prisma.organization.delete({ where: { id: otherOrgId } });
    expect(
      await prisma.modelCreditEntry.findUnique({ where: { id: `other-${stamp}` } }),
    ).toBeNull();
    expect(await runAsTenant(actor, () => service.costReport(actor, range))).toEqual(before);
    expect(before.rows[0]).toMatchObject({
      providerCostUsd: 0.004,
      chargedMicros: "9000",
      knownCostCount: 1,
    });
  });
});
