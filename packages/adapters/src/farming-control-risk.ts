import type { FarmingControlRiskExposure, FarmingControlRiskSignal } from "@rakazo/contracts";
import { FarmingControlDecimalSchema, FarmingControlRiskHistorySchema } from "@rakazo/contracts";
import * as z from "zod";

const text = z.string().max(4_000);
const ms = z.number().int().nonnegative();
const decimal = FarmingControlDecimalSchema.max(512).nullable();
const assessment = z.object({ status: text, severity: text, summary: text });
const point = z.object({
  observedAtMs: ms,
  collectedAtMs: ms,
  blockNumber: z.string().regex(/^\d+$/).max(128),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  metrics: z.object({
    accountAssets: decimal.optional(),
    withdrawableAssets: decimal.optional(),
    liquidityAssets: decimal.optional(),
    exitBufferRatio: decimal.optional(),
    utilizationFraction: decimal.optional(),
    withdrawableFraction: decimal.optional(),
    largestAllocationFraction: decimal.optional(),
  }),
});
const morphoItem = z.object({
  monitorKey: text,
  positionId: text,
  label: text,
  kind: z.enum(["direct_market", "vault"]),
  chainId: z.number().int().positive(),
  address: text,
  assetSymbol: text,
  capacityState: z.enum(["verified", "lower_bound", "unavailable", "blocked"]).optional(),
  capacityMethod: text.nullable().optional(),
  positionState: text,
  dataStatus: z.enum(["live", "stopped", "inactive", "warming_up", "unavailable"]),
  control: z.unknown().optional(),
  history: z.unknown().optional(),
  current: point.nullable(),
  assessments: z.array(assessment.extend({ family: text })).max(64),
  limitations: z.array(text).max(64),
});
const monitorControl = z.object({
  desiredState: z.enum(["stopped", "running", "unknown"]).catch("unknown"),
  actualState: z
    .enum([
      "stopped",
      "starting",
      "warming_up",
      "running",
      "stopping",
      "degraded",
      "unavailable",
      "unknown",
    ])
    .catch("unknown"),
  controlSync: z.enum(["in_sync", "pending", "unavailable", "unknown"]).catch("unknown"),
});
const morphoHistory = FarmingControlRiskHistorySchema.omit({ window: true }).extend({
  points: z.array(z.unknown()).max(3_200),
});
function observation(
  value: z.infer<typeof point>,
  withdrawableVerified: boolean,
): NonNullable<FarmingControlRiskExposure["currentObservation"]> {
  return {
    observedAtMs: value.observedAtMs,
    collectedAtMs: value.collectedAtMs,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    metrics: {
      accountAssets: value.metrics.accountAssets ?? null,
      withdrawableAssets: withdrawableVerified ? (value.metrics.withdrawableAssets ?? null) : null,
      liquidityAssets: value.metrics.liquidityAssets ?? null,
      withdrawableFraction: value.metrics.withdrawableFraction ?? null,
      exitBufferRatio: value.metrics.exitBufferRatio ?? null,
      utilizationFraction: value.metrics.utilizationFraction ?? null,
      largestAllocationFraction: value.metrics.largestAllocationFraction ?? null,
    },
  };
}
const details = z.object({
  monitor: text,
  safeAsset: text.optional(),
  preferredExitAsset: text.optional(),
  safeAssetGrossOutflowFraction: decimal.optional(),
  worstHaircut: decimal.optional(),
  absoluteDeviation: decimal.optional(),
  safeReserveDrain1h: decimal.optional(),
  downside24h: decimal.optional(),
  downside1h: decimal.optional(),
  riskShareChange1h: decimal.optional(),
  riskShareChange24h: decimal.optional(),
  lpSupplyContraction1h: decimal.optional(),
  completeWindowCoverageProven: z.boolean().optional(),
});
const curveItem = z.object({
  monitorKey: text,
  profile: z.object({
    key: text,
    label: text,
    chainId: z.number().int().positive(),
    poolAddress: text,
    positionLinks: z.array(z.object({ positionId: text, mode: text })).max(64),
  }),
  data: z.object({
    status: text,
    snapshot: z
      .object({
        schemaVersion: z.literal("hot-curve-profile-runtime.v1"),
        asOfMs: ms,
        anchor: z.object({ blockTimestampMs: ms, blockNumber: text, blockHash: text }).nullable(),
        evaluation: z
          .object({
            assessments: z
              .array(
                assessment.extend({
                  evaluatorKey: text,
                  subjectKey: text,
                  details,
                }),
              )
              .max(256),
          })
          .nullable(),
      })
      .nullable(),
  }),
});
// Parse bounded envelopes, then each item independently: one unsupported profile cannot erase the others.
export const morphoRiskSource = z.object({
  schemaVersion: z.literal("morpho-monitoring-dashboard.v1"),
  asOfMs: ms,
  window: z.enum(["1h", "24h", "7d"]).optional(),
  items: z.array(z.unknown()).max(64),
});
export const curveRiskSource = z.object({
  schemaVersion: z.literal("curve-risk-hot-pools.v2"),
  asOfMs: ms,
  source: z.literal("hot_supervisor_ram"),
  items: z.array(z.unknown()).max(64),
});
const severityRank = { info: 0, warning: 1, critical: 2 };
const labels: Record<string, string> = {
  identity: "Market identity",
  exit_capacity: "Exit liquidity buffer",
  utilization: "Utilization",
  oracle: "Oracle",
  feed: "Feed freshness",
  realized_bad_debt: "Realized bad debt",
  borrower_health: "Borrower health",
  market_oracle_basis: "Independent market price",
  liquidation_capacity: "Liquidation capacity",
  dependencies: "Dependencies",
  flows: "Flow coverage",
  withdrawal_capacity: "Withdrawal capacity",
  concentration: "Largest market allocation",
  risk_coverage: "Broader risk coverage",
  relative_peg: "Relative peg deviation",
  pool_run: "Reserve trend",
  curve_flows_24h: "Gross reference outflow · 24h",
  position_mark: "Position mark trend",
  executable_exit: "Worst quoted exit haircut",
};
function signal(input: {
  key: string;
  family?: string;
  label?: string;
  status: string;
  severity: string;
  summary: string;
  value?: string | null;
  format?: FarmingControlRiskSignal["format"];
  unit?: string | null;
  partial?: boolean;
}): FarmingControlRiskSignal {
  const assessed = ["healthy", "attention", "action_required"].includes(input.status);
  const native =
    input.severity === "info" || input.severity === "warning" || input.severity === "critical"
      ? input.severity
      : null;
  return {
    key: input.key,
    ...(input.family ? { family: input.family } : {}),
    label: input.label ?? labels[input.family ?? input.key] ?? input.key.replaceAll("_", " "),
    status: input.status,
    severity: assessed ? native : null,
    sourceSeverity: input.severity,
    coverage: !assessed ? "unknown" : input.partial ? "partial" : "current",
    value: assessed ? (input.value ?? null) : null,
    format: input.format ?? "text",
    unit: input.unit ?? null,
    summary: input.summary,
  };
}
function noReading(): FarmingControlRiskSignal[] {
  return [
    {
      key: "no_current_reading",
      label: "Risk signals",
      status: "unavailable",
      severity: null,
      sourceSeverity: null,
      coverage: "unavailable",
      value: null,
      format: "text",
      unit: null,
      summary: "No current accepted risk observation is available for this active exposure.",
    },
  ];
}
function maximum(signals: FarmingControlRiskSignal[]): FarmingControlRiskExposure["maxSeverity"] {
  return signals.reduce<FarmingControlRiskExposure["maxSeverity"]>(
    (max, row) =>
      row.severity !== null && (max === null || severityRank[row.severity] > severityRank[max])
        ? row.severity
        : max,
    null,
  );
}
export function projectRiskExposures(input: {
  morpho: z.infer<typeof morphoRiskSource> | null;
  curve: z.infer<typeof curveRiskSource> | null;
  positions: Array<{ id: string; label: string | null }>;
  nowMs: number;
}): {
  exposures: FarmingControlRiskExposure[];
  issues: string[];
  incomplete: { morpho: boolean; curve: boolean };
} {
  const positions = new Map(
    input.positions.map((p) => [p.id, { id: p.id, label: p.label ?? p.id }]),
  );
  const exposures: FarmingControlRiskExposure[] = [];
  const issues: string[] = [];
  let invalid = 0;
  const incomplete = { morpho: false, curve: false };
  const fresh = (at: number) => input.nowMs >= at && input.nowMs - at <= 90_000;
  for (const raw of input.morpho?.items ?? []) {
    const parsed = morphoItem.safeParse(raw);
    if (!parsed.success) {
      invalid += 1;
      incomplete.morpho = true;
      continue;
    }
    const item = parsed.data;
    const position = positions.get(item.positionId);
    if (!position || item.positionState !== "active") continue;
    const current =
      item.dataStatus === "live" && item.current && fresh(item.current.collectedAtMs)
        ? item.current
        : null;
    const signals = current
      ? item.assessments.map((a) => {
          const metric = {
            exit_capacity: "exitBufferRatio",
            utilization: "utilizationFraction",
            withdrawal_capacity: "withdrawableFraction",
            concentration: "largestAllocationFraction",
          } as const;
          const key = metric[a.family as keyof typeof metric];
          return signal({
            key: a.family,
            status: a.status,
            severity: a.severity,
            summary: a.summary,
            value: key ? (current.metrics[key] ?? null) : null,
            format: key === "exitBufferRatio" ? "ratio" : key ? "fraction" : "text",
          });
        })
      : noReading();
    const control = monitorControl.safeParse(item.control);
    const parsedHistory = morphoHistory.safeParse(item.history);
    let history: FarmingControlRiskExposure["history"];
    let lastKnownObservation: FarmingControlRiskExposure["lastKnownObservation"] = null;
    if (parsedHistory.success) {
      const h = parsedHistory.data;
      history = {
        status: h.status,
        ...(input.morpho?.window ? { window: input.morpho.window } : {}),
        requestedFromMs: h.requestedFromMs,
        requestedThroughMs: h.requestedThroughMs,
        truncated: h.truncated,
        recordsRead: h.recordsRead,
      };
      // Historical points do not carry per-point vault capacity verification;
      // retain owned assets but never imply their amount is proven withdrawable.
      for (const rawPoint of h.points) {
        const parsedPoint = point.safeParse(rawPoint);
        if (!parsedPoint.success) {
          invalid += 1;
          incomplete.morpho = true;
          continue;
        }
        const p = parsedPoint.data;
        if (p.observedAtMs < h.requestedFromMs || p.observedAtMs > h.requestedThroughMs) continue;
        if (
          !lastKnownObservation ||
          p.observedAtMs > lastKnownObservation.observedAtMs ||
          (p.observedAtMs === lastKnownObservation.observedAtMs &&
            p.collectedAtMs > lastKnownObservation.collectedAtMs)
        ) {
          lastKnownObservation = {
            ...observation(p, item.kind !== "vault"),
            source: "accepted_finalized_history",
          };
        }
      }
    } else if (item.history !== undefined) {
      incomplete.morpho = true;
      invalid += 1;
    }
    // Our freshness guard may expire between FC's read and projection. Keep that
    // accepted point dated, without retaining its assessments as current risk.
    const aged =
      item.dataStatus === "live" &&
      item.current &&
      !current &&
      item.current.collectedAtMs <= input.nowMs
        ? item.current
        : null;
    if (
      aged &&
      (!lastKnownObservation ||
        aged.observedAtMs > lastKnownObservation.observedAtMs ||
        (aged.observedAtMs === lastKnownObservation.observedAtMs &&
          aged.collectedAtMs > lastKnownObservation.collectedAtMs))
    ) {
      lastKnownObservation = {
        ...observation(aged, item.kind !== "vault" || item.capacityState === "verified"),
        source: "aged_live",
      };
    }
    if (
      current &&
      lastKnownObservation?.blockHash === current.blockHash &&
      lastKnownObservation.blockNumber === current.blockNumber &&
      lastKnownObservation.collectedAtMs === current.collectedAtMs
    ) {
      lastKnownObservation = null;
    }
    const kind = item.kind === "vault" ? "vault" : "market";
    exposures.push({
      id: item.monitorKey,
      protocol: kind === "vault" ? "Morpho vault" : "Morpho Blue",
      kind,
      label: item.label,
      chainId: item.chainId,
      monitorKey: item.monitorKey,
      subject: { kind, id: item.monitorKey, address: item.address },
      positions: [position],
      dataStatus: current
        ? "live"
        : item.dataStatus === "live"
          ? item.current
            ? "stale"
            : "unavailable"
          : item.dataStatus,
      assetSymbol: item.assetSymbol,
      ...(item.capacityState ? { capacityState: item.capacityState } : {}),
      ...(item.capacityMethod !== undefined ? { capacityMethod: item.capacityMethod } : {}),
      monitorControl: control.success ? control.data : null,
      currentObservation: current
        ? observation(current, item.kind !== "vault" || item.capacityState === "verified")
        : null,
      lastKnownObservation,
      ...(history ? { history } : {}),
      observedAtMs: current?.observedAtMs ?? null,
      collectedAtMs: current?.collectedAtMs ?? null,
      blockNumber: current?.blockNumber ?? null,
      blockHash: current?.blockHash ?? null,
      signals: signals.length ? signals : noReading(),
      maxSeverity: maximum(signals),
      coverage: current ? "partial" : "unknown",
      limitations: item.limitations,
    });
  }
  for (const raw of input.curve?.items ?? []) {
    const parsed = curveItem.safeParse(raw);
    if (!parsed.success) {
      invalid += 1;
      incomplete.curve = true;
      continue;
    }
    const item = parsed.data;
    const links = item.profile.positionLinks.filter(
      (p) => p.mode === "active_exposure" || p.mode === "exposure_unknown",
    );
    const linked = links.flatMap((p) =>
      positions.get(p.positionId) ? [positions.get(p.positionId)!] : [],
    );
    if (!linked.length) continue;
    const linkedIds = new Set(linked.map((p) => p.id));
    const snapshot = item.data.status === "live" ? item.data.snapshot : null;
    const current =
      snapshot?.anchor && snapshot.evaluation && fresh(snapshot.asOfMs) ? snapshot : null;
    const signals =
      current?.evaluation?.assessments
        .filter(
          (a) =>
            a.subjectKey === `curve-pool:${item.profile.key}` ||
            [...linkedIds].some((id) => a.subjectKey === `position:${id}`),
        )
        .map((a) => {
          const d = a.details;
          const value = {
            relative_peg: d.absoluteDeviation,

            curve_flows_24h: d.safeAssetGrossOutflowFraction,

            executable_exit: d.worstHaircut,
          }[d.monitor];
          const row = signal({
            key: a.evaluatorKey,
            family: d.monitor,
            ...(d.monitor === "curve_flows_24h"
              ? { label: `Gross ${d.safeAsset ?? "reference"} outflow · 24h` }
              : {}),
            status: a.status,
            severity: a.severity,
            summary: a.summary,
            value: value ?? null,
            format: value == null ? "text" : "fraction",
            unit: d.safeAsset ?? d.preferredExitAsset ?? null,
            partial: d.monitor === "curve_flows_24h" && d.completeWindowCoverageProven !== true,
          });
          const metrics =
            d.monitor === "pool_run"
              ? ([
                  ["risk_share_change_1h", "Risk share change · 1h", d.riskShareChange1h],
                  ["risk_share_change_24h", "Risk share change · 24h", d.riskShareChange24h],
                  [
                    "reference_reserve_drain_1h",
                    "Reference reserve drain · 1h",
                    d.safeReserveDrain1h,
                  ],
                  [
                    "lp_supply_contraction_1h",
                    "LP supply contraction · 1h",
                    d.lpSupplyContraction1h,
                  ],
                ] as const)
              : d.monitor === "position_mark"
                ? ([
                    ["downside_1h", "Position mark downside · 1h", d.downside1h],
                    ["downside_24h", "Position mark downside · 24h", d.downside24h],
                  ] as const)
                : [];
          if (metrics.length)
            row.metrics = metrics.map(([key, label, value]) => ({
              key,
              label,
              value: value ?? null,
              format: "fraction",
              unit: null,
            }));
          return row;
        }) ?? noReading();
    exposures.push({
      id: item.monitorKey,
      protocol: "Curve pool",
      kind: "pool",
      label: item.profile.label,
      chainId: item.profile.chainId,
      monitorKey: item.monitorKey,
      subject: {
        kind: "pool",
        id: item.monitorKey,
        address: item.profile.poolAddress,
      },
      positions: linked,
      dataStatus: current
        ? "live"
        : item.data.status === "live"
          ? snapshot
            ? "stale"
            : "unavailable"
          : item.data.status,
      observedAtMs: current?.anchor?.blockTimestampMs ?? null,
      collectedAtMs: current?.asOfMs ?? null,
      blockNumber: current?.anchor?.blockNumber ?? null,
      blockHash: current?.anchor?.blockHash ?? null,
      signals: signals.length ? signals : noReading(),
      maxSeverity: maximum(signals),
      coverage: current ? "partial" : "unknown",
      limitations: [
        "Pool and linked-position assessments cover only their named policies; other portfolio risks are not established.",
        ...(links.some((p) => linkedIds.has(p.positionId) && p.mode === "exposure_unknown")
          ? ["Linked position exposure is not fully proven."]
          : []),
      ],
    });
  }
  for (const card of exposures) {
    if (card.signals.length > 64) {
      card.signals.sort(
        (a, b) =>
          (b.severity === null ? -1 : severityRank[b.severity]) -
          (a.severity === null ? -1 : severityRank[a.severity]),
      );
      card.signals = card.signals.slice(0, 64);
      card.limitations.push("Additional assessment families were omitted by the response bound.");
      invalid += 1;
      incomplete[card.kind === "pool" ? "curve" : "morpho"] = true;
    }
  }
  if (exposures.length > 64) {
    invalid += 1;
    incomplete.curve = true;
  }
  if (invalid)
    issues.push(
      "Some risk profiles or assessment families were omitted by schema or response bounds; supported evidence remains available.",
    );
  const seen = new Set<string>();
  return {
    exposures: exposures.filter((card) => !seen.has(card.id) && !!seen.add(card.id)).slice(0, 64),
    issues,
    incomplete,
  };
}
