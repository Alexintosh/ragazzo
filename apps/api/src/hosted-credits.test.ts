import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import {
  CreditAdjustmentInputSchema,
  CreditCostReportInputSchema,
  UpdateHostedCreditPolicyInputSchema,
} from "@rakazo/contracts";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createHostedCreditServices, journalDto } from "./hosted-credits.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture(options: { admin?: boolean; verified?: boolean } = {}) {
  const financialQuery = vi.fn(async () => {
    throw new Error("Forbidden query reached");
  });
  const deps = {
    prisma: {
      user: {
        findUnique: vi.fn(async () => ({
          email: actor.email,
          emailVerified: options.verified ?? true,
        })),
      },
      modelCreditAccount: { aggregate: financialQuery },
      modelCreditEntry: { aggregate: financialQuery },
      organization: { findMany: financialQuery },
      billingAuditEvent: { findMany: financialQuery },
      hostedCreditPolicy: { findUniqueOrThrow: financialQuery },
      hostedCreditTariff: { findMany: financialQuery },
      $queryRaw: financialQuery,
    },
    env: {
      adminEmails: options.admin ? [actor.email] : [],
      defaultProvider: "fake",
      defaultModel: "fake",
      agentRuntime: "scripted",
    },
  } as unknown as RouterDeps;
  const router = createRouter(deps);
  return {
    deps,
    financialQuery,
    client: (current: Actor | null) => createRouterClient(router, { context: { actor: current } }),
  };
}
const policy = {
  enabled: true,
  defaultDailyAllowanceMicros: "1000",
  dailyGrantBudgetMicros: "10000",
  reason: "Fixture policy",
  idempotencyKey: "request_policy",
};
const tariff = {
  provider: "fake",
  model: "fixture",
  multiplierBps: 10000,
  reason: "Fixture tariff",
  idempotencyKey: "request_tariff",
};
const adjustment = {
  organizationId: "another-org",
  amountMicros: "1000",
  reason: "Fixture correction",
  idempotencyKey: "request_adjust",
};
const operations = (client: ReturnType<ReturnType<typeof fixture>["client"]>) => [
  () => client.creditAdmin.overview(),
  () => client.creditAdmin.accounts({}),
  () => client.creditAdmin.journal({}),
  () => client.creditAdmin.policy(),
  () => client.creditAdmin.updatePolicy(policy),
  () => client.creditAdmin.tariffs(),
  () => client.creditAdmin.updateTariff(tariff),
  () => client.creditAdmin.adjustment(adjustment),
  () => client.creditAdmin.updateAllowance({ ...adjustment, dailyAllowanceMicros: "1000" }),
  () => client.creditAdmin.costReport({ from: "2026-01-01", to: "2026-01-02" }),
];

describe("hosted credit operator authorization", () => {
  it("requires authentication for every operator operation and public account status", async () => {
    const { client, financialQuery } = fixture();
    for (const operation of operations(client(null)))
      await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(null).hostedCredits.status()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client(null).hostedCredits.tariffs()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(financialQuery).not.toHaveBeenCalled();
  });
  it.each([
    { admin: false, verified: true },
    { admin: true, verified: false },
  ])(
    "rejects an organization owner without a verified deployment allowlist match: %j",
    async (options) => {
      const { client, financialQuery } = fixture(options);
      // A forged legacy owner claim also confers no deployment authority.
      const owner = { ...actor, isDeploymentOwner: true };
      for (const operation of operations(client(owner)))
        await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(financialQuery).not.toHaveBeenCalled();
    },
  );
  it("enters an explicit system scope only after deployment authorization", async () => {
    const { deps } = fixture({ admin: true });
    const query = vi.fn(async () => {
      expect(currentDbContext()).toMatchObject({
        kind: "system",
        reason: "deployment operator hosted credit management",
      });
      return [{ accountCount: 2n, balanceMicros: 3000n, pendingCount: 2n, pendingMicros: 400n }];
    });
    deps.prisma.$queryRaw = query as never;
    expect(await createHostedCreditServices(deps).overview(actor)).toEqual({
      accountCount: 2,
      balanceMicros: "3000",
      pendingCount: 2,
      pendingMicros: "400",
    });
    expect(currentDbContext()).toBeUndefined();
  });
});

describe("hosted credit boundary validation", () => {
  it("requires nonzero integer correction, reason and stable replay key", () => {
    for (const invalid of [
      { amountMicros: "0" },
      { amountMicros: "1.5" },
      { amountMicros: "1e6" },
      { reason: " " },
      { idempotencyKey: "short" },
    ])
      expect(CreditAdjustmentInputSchema.safeParse({ ...adjustment, ...invalid }).success).toBe(
        false,
      );
    expect(
      CreditAdjustmentInputSchema.parse({ ...adjustment, amountMicros: "-1000" }).amountMicros,
    ).toBe("-1000");
    expect(
      UpdateHostedCreditPolicyInputSchema.parse({
        ...policy,
        enabled: false,
        defaultDailyAllowanceMicros: "0",
        dailyGrantBudgetMicros: "0",
      }),
    ).toMatchObject({ enabled: false });
  });
  it("bounds report time to valid exclusive UTC day intervals", () => {
    expect(
      CreditCostReportInputSchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success,
    ).toBe(false);
    expect(
      CreditCostReportInputSchema.safeParse({ from: "2026-01-01", to: "2027-01-01" }).success,
    ).toBe(false);
    expect(
      CreditCostReportInputSchema.safeParse({ from: "2026-01-01", to: "2026-01-01" }).success,
    ).toBe(false);
    expect(CreditCostReportInputSchema.parse({ from: "2026-01-01", to: "2026-01-02" })).toEqual({
      from: "2026-01-01",
      to: "2026-01-02",
    });
  });
  it("projects journal metadata without raw receipts, provider requests, secrets or settings", () => {
    const event = journalDto({
      id: "event",
      kind: "hosted_policy",
      organizationId: null,
      amountMicros: 0n,
      provider: null,
      model: null,
      details: {
        actorId: "operator",
        reason: "Fixture update",
        previous: { secret: "not-exported" },
        current: { accessToken: "not-exported" },
        usage: { raw: "not-exported" },
      },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(event).toEqual({
      id: "event",
      kind: "hosted_policy",
      organizationId: null,
      amountMicros: "0",
      provider: null,
      model: null,
      actorId: "operator",
      reason: "Fixture update",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("not-exported");
  });
});
