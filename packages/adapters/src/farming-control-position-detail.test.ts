import type { Actor } from "@rakazo/contracts";
import { FarmingControlPositionDetailSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createFarmingControlClient } from "./farming-control.js";
import {
  detailActivitiesSource,
  detailActivity,
  detailTransaction,
} from "./farming-control-position-detail.js";
import { createFarmingControlService } from "./farming-control-service.js";

const address = `0x${"1".repeat(40)}`;
const hiddenAddress = `0x${"2".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const now = 1_800_000_000_000;
function activity(account?: string) {
  return {
    id: "activity",
    positionId: "position",
    kind: "claim",
    status: "confirmed",
    sourceId: "onchain",
    evidenceId: "evidence",
    occurredAtMs: now - 10,
    recordedAtMs: now,
    transactionRef: { namespace: "eip155", chainId: 1, hash, url: "https://untrusted.example" },
    properties: account ? { account } : {},
    legs: [
      {
        amountKind: "decimal",
        amountText: "0.000000000000000001",
        assetSnapshot: { symbol: "TOKEN" },
        properties: {},
      },
    ],
  };
}
function fixture(
  options: {
    hidden?: boolean;
    changed?: boolean;
    rewards?: boolean;
    adapter?: string;
    truncated?: boolean;
  } = {},
) {
  let settingsReads = 0;
  const visibility = {
    revision: 1,
    active: options.hidden ?? false,
    hiddenWalletAddresses: options.hidden ? [hiddenAddress] : [],
  };
  const walletSettings = {
    ...visibility,
    wallets: [
      { address, label: "Visible wallet", visible: true, positionIds: ["position"] },
      {
        address: hiddenAddress,
        label: "Hidden wallet marker",
        visible: false,
        positionIds: ["position"],
      },
    ],
  };
  const positions = {
    asOfMs: now,
    walletVisibility: visibility,
    walletAttribution: { complete: true },
    scope: {
      assetSetKey: null,
      label: "All",
      includedPositionIds: ["position"],
      availableAssetSets: [],
    },
    cumulative: {
      currentPricedValueUsd: null,
      currentBlendedApr: null,
      expectedYield30dUsd: null,
      liveEarnedUsd: null,
      liveEarnedBreakdownUsd: {
        unrealized: null,
        claimableNotRealized: null,
        nature: "current_observed_marks_not_realized_roi",
        valuationComplete: false,
      },
      coverage: {
        projectionCoverageRatio: null,
        includedPositionIds: ["position"],
        excluded: [],
        earnedExcludedPositionIds: [],
        earnedExcluded: [],
        lifecycleExcludedPositionIds: [],
      },
    },
    items: [
      {
        id: "position",
        label: "Example",
        state: "active",
        adapter: { key: options.adapter ?? "fixture" },
        current: {
          valueUsd: null,
          capitalBaselineUsd: null,
          observedAtMs: null,
          nature: "mark_to_market",
        },
        apr: null,
        dataQuality: {
          hasObservations: true,
          lastObservedAtMs: now,
          rateObservedAtMs: null,
          maxObservationAgeMs: 60_000,
        },
        entryTransactions: [
          {
            activityId: "opening",
            activityKind: "position.open",
            status: "confirmed",
            sourceId: "onchain",
            occurredAtMs: now - 100,
            namespace: "eip155",
            chainId: "1",
            hash,
          },
          {
            activityId: "not-opening",
            activityKind: "position.open",
            status: "pending",
            sourceId: "operator",
            occurredAtMs: now - 200,
            chainId: "1",
            hash,
          },
        ],
      },
    ],
  };
  const reward = {
    id: "reward",
    positionId: "position",
    account: address,
    observedAtMs: now,
    sourceObservationId: "observation",
    retrievalComplete: true,
    reward: {
      token: address,
      symbol: "TOKEN",
      amountRaw: "1000000000000000001",
      amount: "1.000000000000000001",
    },
    informational: { quality: "current", quantityObservedAtMs: now, readiness: "unsupported" },
    execution: { claimSupported: false, reason: "unsupported" },
  };
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/settings/wallet-visibility") {
      settingsReads++;
      return Response.json({
        ...walletSettings,
        revision: options.changed && settingsReads > 1 ? 2 : 1,
      });
    }
    if (url.pathname === "/positions") return Response.json(positions);
    if (url.pathname.endsWith("/activities"))
      return Response.json({
        items: options.truncated
          ? Array.from({ length: 101 }, (_, i) => ({ ...activity(address), id: `activity-${i}` }))
          : [
              activity(address),
              { ...activity(hiddenAddress), id: "hidden-activity" },
              { ...activity(), id: "unattributed" },
            ],
      });
    if (url.pathname === "/harvest/inventory")
      return Response.json({
        asOfMs: now,
        walletVisibility: visibility,
        walletVisibilityCoverage: { complete: true },
        items: options.rewards ? [reward] : [],
      });
    throw new Error("unexpected source");
  });
  return {
    client: createFarmingControlClient({
      baseUrl: "http://127.0.0.1:9876",
      fetch: transport,
      now: () => now,
    }),
    transport,
  };
}

describe("position detail evidence projection", () => {
  it("constructs explorer links only from exact known chain/hash identity", () => {
    expect(detailTransaction({ chainId: "1", hash })?.explorerUrl).toBe(
      `https://etherscan.io/tx/${hash}`,
    );
    expect(detailTransaction({ chainId: "999", hash })?.explorerUrl).toBeNull();
    expect(detailTransaction({ chainId: "1", hash: "invalid" })).toBeNull();
    expect(detailTransaction({ namespace: "other", chainId: "1", hash })).toBeNull();
  });
  it("omits ambiguous and hidden activity attribution and preserves exact visible amounts", () => {
    const parse = (value: unknown) => detailActivitiesSource.parse({ items: [value] }).items[0]!;
    expect(detailActivity(parse(activity()), true, new Set([address]))).toBeNull();
    expect(detailActivity(parse(activity(hiddenAddress)), true, new Set([address]))).toBeNull();
    expect(detailActivity(parse(activity(address)), true, new Set([address]))).toMatchObject({
      amount: "0.000000000000000001",
      sourceId: "onchain",
      evidenceId: "evidence",
    });
  });
  it("joins visible wallets, confirmed opening, and claimable reward provenance without leaking hidden rows", async () => {
    const { client, transport } = fixture({
      hidden: true,
      rewards: true,
      adapter: "beefy-cow-clm-vault",
    });
    const result = FarmingControlPositionDetailSchema.parse(
      await client.positionDetail({ positionId: "position" }),
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.opening).toMatchObject({
      id: "opening",
      status: "confirmed",
      transaction: { explorerUrl: `https://etherscan.io/tx/${hash}` },
    });
    expect(result.wallets).toEqual([{ address, label: "Visible wallet" }]);
    expect(result.activities).toMatchObject({ complete: false, state: "partial" });
    expect(result.activities.items).toHaveLength(1);
    expect(result.rewards.items[0]).toMatchObject({
      amount: "1.000000000000000001",
      sourceObservationId: "observation",
      readiness: "unsupported",
    });
    expect(result.harvesting.mode).toBe("mixed");
    expect(JSON.stringify(result)).not.toContain(hiddenAddress);
    expect(JSON.stringify(result)).not.toContain("Hidden wallet marker");
    expect(JSON.stringify(result)).not.toContain("hidden-activity");
    for (const [url, init] of transport.mock.calls) {
      expect(init?.method).toBe("GET");
      if (new URL(String(url)).pathname === "/harvest/inventory")
        expect(String(url)).toContain("walletVisibilityRevision=1");
    }
  });
  it("fails closed when the saved wallet revision changes", async () => {
    const { client } = fixture({ changed: true });
    expect(await client.positionDetail({ positionId: "position" })).toMatchObject({
      status: "unavailable",
    });
  });
  it("does not discover invisible IDs or fetch their canonical ledger", async () => {
    const { client, transport } = fixture();
    expect(await client.positionDetail({ positionId: "hidden-position" })).toMatchObject({
      status: "unavailable",
    });
    expect(transport.mock.calls).toHaveLength(2);
  });
  it("marks a bounded ledger window truncated, and distinguishes unknown and evidenced auto modes", async () => {
    const { client } = fixture({ truncated: true });
    const result = await client.positionDetail({ positionId: "position" });
    expect(result).toMatchObject({
      status: "matched",
      activities: { truncated: true, complete: false },
      harvesting: { mode: "unknown" },
    });
    if (result.status === "matched") expect(result.activities.items).toHaveLength(100);
    expect(
      await fixture({ adapter: "beefy-cow-clm-vault" }).client.positionDetail({
        positionId: "position",
      }),
    ).toMatchObject({ harvesting: { mode: "auto" } });
  });
});

describe("position detail authorization", () => {
  it("rejects another actor and a shared workspace before any host reads", async () => {
    const actor: Actor = {
      userId: "fixture-owner",
      spaceId: "personal-space",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const findFirst = vi.fn().mockResolvedValue({
      id: actor.spaceId,
      organizationId: actor.spaceId,
      deletingAt: null,
      memberships: [
        { userId: actor.userId, role: "owner" },
        { userId: "peer", role: "member" },
      ],
      organization: { members: [{ userId: actor.userId, role: "owner" }] },
    });
    const transport = vi.fn<typeof fetch>();
    const prisma = { space: { findFirst } } as unknown as Pick<PrismaClient, "space">;
    const service = createFarmingControlService(
      prisma,
      { farmingControlApiUrl: "http://127.0.0.1:9876", farmingControlOwnerUserId: actor.userId },
      transport,
    );
    await expect(
      service.positionDetail({ ...actor, userId: "other" }, { positionId: "position" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(findFirst).not.toHaveBeenCalled();
    await expect(service.positionDetail(actor, { positionId: "position" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
