import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import { creditAccount, modelChargeMicros } from "./model-credits.js";

describe("model tariffs", () => {
  it("keeps provider cost distinct from the rounded retail charge", () => {
    expect(modelChargeMicros(0.000001, 15_000)).toEqual({
      providerCostMicros: 1n,
      chargedMicros: 2n,
    });
    expect(modelChargeMicros(0.125, 20_000)).toEqual({
      providerCostMicros: 125_000n,
      chargedMicros: 250_000n,
    });
    expect(modelChargeMicros(0)).toEqual({ providerCostMicros: 0n, chargedMicros: 0n });
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or overflowing costs %s",
    (cost) => {
      expect(() => modelChargeMicros(cost)).toThrow("Invalid model cost");
    },
  );
  it.each([0, -1, 1.5, 1_000_001])("rejects invalid tariffs %s", (tariff) => {
    expect(() => modelChargeMicros(1, tariff)).toThrow("Invalid hosted model tariff");
  });
});

describe("creditAccount", () => {
  const organizationId = "credit-race-fixture";
  const account = { organizationId, balanceMicros: 0n, mode: null };

  function fixture(error?: Error) {
    const upsert = error
      ? vi.fn().mockRejectedValueOnce(error)
      : vi.fn().mockResolvedValue(account);
    const findUniqueOrThrow = vi.fn().mockResolvedValue(account);
    const prisma = {
      modelCreditAccount: { upsert, findUniqueOrThrow },
    } as unknown as PrismaClient;
    return { prisma, upsert, findUniqueOrThrow };
  }

  it("returns the winning account after a concurrent first create conflicts", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { modelName: "ModelCreditAccount", target: ["organizationId"] },
    });
    const { prisma, upsert, findUniqueOrThrow } = fixture(conflict);

    await expect(creditAccount(prisma, organizationId)).resolves.toBe(account);
    expect(upsert).toHaveBeenCalledOnce();
    expect(findUniqueOrThrow).toHaveBeenCalledExactlyOnceWith({ where: { organizationId } });
  });

  it("returns the account without another read when the upsert succeeds", async () => {
    const { prisma, findUniqueOrThrow } = fixture();

    await expect(creditAccount(prisma, organizationId)).resolves.toBe(account);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Connection failed"),
    new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    }),
  ])("propagates other failures without reading an account: %s", async (error) => {
    const { prisma, findUniqueOrThrow } = fixture(error);

    await expect(creditAccount(prisma, organizationId)).rejects.toBe(error);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
