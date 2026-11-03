import type { ModelCallObserver } from "@rakazo/adapter-kit";
import {
  creditAccount,
  getHostedCreditPolicy,
  hostedModelMeteringEnabled,
  organizationForMember,
  reserveModelCredits,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedModelCreditObserver } from "./model-credit-observer.js";
import { resolveModelKey } from "./run-model.js";

vi.mock("@rakazo/db", () => ({
  organizationForMember: vi.fn(),
  creditAccount: vi.fn(),
  getHostedCreditPolicy: vi.fn(),
  hostedModelMeteringEnabled: vi.fn(),
  reserveModelCredits: vi.fn(),
  recordModelCreditReceipt: vi.fn(),
}));

const scope = { userId: "user-1", spaceId: "space-1" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
  vi.mocked(organizationForMember).mockResolvedValue({ organizationId: "org-1" } as never);
  vi.mocked(hostedModelMeteringEnabled).mockResolvedValue(true);
  vi.mocked(getHostedCreditPolicy).mockResolvedValue({
    enabled: false,
    activatedAt: null,
  } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("hosted model credit gate", () => {
  it("refuses BYOK accounts even if old owner and subscription records exist", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "byok" } as never);
    const findUnique = vi.fn(async () => ({ ownerUserId: scope.userId, status: "active" }));
    await expect(
      hostedModelCreditObserver(
        { deploymentSettings: { findUnique }, billingAccount: { findUnique } } as never,
        scope,
      ),
    ).rejects.toThrow("Connect your own API key");
    expect(findUnique).not.toHaveBeenCalled();
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
  it("requires a reservation before a funded-mode account may use the server key", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
    vi.mocked(reserveModelCredits).mockRejectedValue(new Error("Not enough model credits"));
    const observer = await hostedModelCreditObserver({} as never, scope);
    const call = {
      callId: "call-1",
      maxCostUsd: 0.02,
      provider: "test-provider",
      modelId: "test-model",
      runId: "run-1",
    } as Parameters<ModelCallObserver["beforeCall"]>[0];
    await expect(observer.beforeCall(call)).rejects.toThrow("Not enough model credits");
    expect(reserveModelCredits).toHaveBeenCalledWith({}, "org-1", 0.02, {
      ...scope,
      callId: "call-1",
      runId: "run-1",
      provider: "test-provider",
      model: "test-model",
    });
  });
  it("requires a reservation for new hosted accounts without a paid plan", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: null } as never);
    vi.mocked(getHostedCreditPolicy).mockResolvedValue({
      enabled: true,
      activatedAt: new Date(),
    } as never);
    vi.mocked(reserveModelCredits).mockResolvedValue("reservation-1");
    const observer = await hostedModelCreditObserver({} as never, scope);
    await expect(
      observer.beforeCall({
        callId: "hosted-call",
        maxCostUsd: 0.02,
        provider: "test",
        modelId: "test",
      } as never),
    ).resolves.toBe("reservation-1");
    expect(reserveModelCredits).toHaveBeenCalledOnce();
  });
  it("refuses hosted access after the policy has been suspended", async () => {
    vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
    vi.mocked(getHostedCreditPolicy).mockResolvedValue({
      enabled: false,
      activatedAt: new Date(),
    } as never);
    await expect(hostedModelCreditObserver({} as never, scope)).rejects.toThrow(
      "Connect your own API key",
    );
    expect(reserveModelCredits).not.toHaveBeenCalled();
  });
  it.each([
    { activation: "policy", missingCredential: false },
    { activation: "policy", missingCredential: true },
    { activation: "billing", missingCredential: false },
  ])(
    "rechecks $activation activation and suspension on the same legacy credential material (missing stored key=$missingCredential)",
    async ({ activation, missingCredential }) => {
      let enabled = false;
      let activatedAt: Date | null = null;
      let billingEnabled = false;
      vi.mocked(hostedModelMeteringEnabled).mockImplementation(
        async () => enabled || activatedAt !== null || billingEnabled,
      );
      vi.mocked(getHostedCreditPolicy).mockImplementation(
        async () => ({ enabled, activatedAt }) as never,
      );
      vi.mocked(creditAccount).mockResolvedValue({ mode: "credits" } as never);
      vi.mocked(reserveModelCredits).mockResolvedValue("reservation-live");
      const material = await resolveModelKey(
        {
          prisma: { secret: { findFirst: async () => null } },
          deploymentModelKey: "fixture-key",
        } as never,
        scope.userId,
        scope.spaceId,
        missingCredential
          ? { id: "missing", provider: "openrouter", secretId: "missing-secret" }
          : null,
        "openrouter",
        "fixture",
      );
      expect(material.apiKey).toBe("fixture-key");
      expect(material.callObserver).toBeDefined();
      const call = {
        callId: "call-live",
        maxCostUsd: 0.02,
        provider: "openrouter",
        modelId: "fixture",
      } as never;
      await expect(material.callObserver!.beforeCall(call)).resolves.toBeUndefined();
      expect(reserveModelCredits).not.toHaveBeenCalled();
      if (activation === "policy") {
        enabled = true;
        activatedAt = new Date();
      } else billingEnabled = true;
      await expect(material.callObserver!.beforeCall(call)).resolves.toBe("reservation-live");
      expect(reserveModelCredits).toHaveBeenCalledOnce();
      enabled = false;
      activatedAt = new Date();
      await expect(material.callObserver!.beforeCall(call)).rejects.toThrow(
        "Connect your own API key",
      );
      expect(reserveModelCredits).toHaveBeenCalledOnce();
    },
  );
});
