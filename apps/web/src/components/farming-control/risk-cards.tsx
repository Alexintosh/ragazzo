import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  FarmingControlRisk,
  FarmingControlRiskExposure,
  FarmingControlRiskReview,
  FarmingControlRiskSignal,
} from "@rakazo/contracts";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { ArrowUpRight, ChevronRight, Clock3, Link2, MessageSquare, Shield } from "lucide-react";
import { useState } from "react";
import { Empty, exactAmount, exactPercent } from "./presentation";

type Severity = FarmingControlRiskSignal["severity"];
type Props = {
  data: FarmingControlRisk;
  onMention: (
    exposure: FarmingControlRiskExposure,
    signal?: FarmingControlRiskSignal,
  ) => Promise<void>;
  onReview?: (monitorKey: string) => void;
  demoMode?: boolean;
  mentionBusy?: boolean;
  mentionError?: string | null;
};

const severityColor = {
  info: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

function SignalShape({ severity }: { severity: Severity }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
      {severity === "critical" ? (
        <path d="M6 1 11 11H1Z" fill="currentColor" />
      ) : severity === "warning" ? (
        <path d="m6 1 5 5-5 5-5-5Z" fill="currentColor" />
      ) : (
        <circle
          cx="6"
          cy="6"
          r="3.5"
          fill={severity === "info" ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}

function useSeverityLabels() {
  const { t } = useLingui();
  return {
    info: t`Within limits`,
    warning: t`Watch`,
    critical: t`Action required`,
    unknown: t`No reading`,
  };
}

/** An ordinal indicator of observed signals, never a numerical or whole-position risk score. */
function RiskGauge({ exposure }: { exposure: FarmingControlRiskExposure }) {
  const { t } = useLingui();
  const labels = useSeverityLabels();
  const severity = exposure.maxSeverity;
  const label = labels[severity ?? "unknown"];
  const coverage = exposure.coverage === "unknown" ? t`Unknown coverage` : t`Partial coverage`;
  const angle = severity === "info" ? -60 : severity === "warning" ? 0 : 60;
  return (
    <div className="w-24 shrink-0 text-center">
      <svg
        role="img"
        aria-label={t`Highest observed severity: ${label}. ${coverage}.`}
        viewBox="0 0 88 48"
        className={cn("mx-auto h-10 w-20", severityColor[severity ?? "unknown"])}
      >
        <path
          d="M9 40a35 35 0 0 1 70 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray="3 5"
          className="text-muted-foreground/25"
        />
        {severity !== null ? (
          <g transform={`rotate(${angle} 44 40)`}>
            <path d="M44 13v7" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
            <path d="M44 25v15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="44" cy="40" r="3" fill="currentColor" />
          </g>
        ) : (
          <circle cx="44" cy="34" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
      <div
        className={cn(
          "text-[10px] font-medium leading-tight",
          severityColor[severity ?? "unknown"],
        )}
      >
        {label}
      </div>
      <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{coverage}</div>
    </div>
  );
}

function chainName(chainId: number, fallback: string) {
  const names: Record<number, string> = {
    1: "Ethereum",
    10: "Optimism",
    56: "BNB Chain",
    100: "Gnosis",
    137: "Polygon",
    8453: "Base",
    42161: "Arbitrum",
    43114: "Avalanche",
  };
  return names[chainId] ?? fallback;
}

function ObservationTime({ value }: { value: number | null }) {
  const { t } = useLingui();
  if (value === null) return <>{t`No current observation`}</>;
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {t`Observed`}{" "}
      {date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })}
    </time>
  );
}

function signalValue(
  signal: Pick<FarmingControlRiskSignal, "value" | "format" | "unit">,
  unavailable: string,
  demoMode = false,
) {
  if (signal.value === null) return unavailable;
  if (demoMode && (signal.format === "amount" || signal.format === "text")) return "—";
  if (signal.format === "fraction") {
    // Shift the source decimal exactly; no floating-point financial conversion.
    const match = /^([+-]?(?:\d*\.?\d+|\d+\.?))(?:e([+-]?\d+))?$/i.exec(signal.value);
    if (!match) return "—";
    return exactPercent(`${match[1]}e${BigInt(match[2] ?? "0") + 2n}`);
  }
  if (signal.format === "ratio") {
    const formatted = exactPercent(signal.value);
    return formatted === "—" ? formatted : `${formatted.slice(0, -1)}×`;
  }
  if (signal.format === "amount") return exactAmount(signal.value, signal.unit ?? "USD");
  return signal.value;
}

function SignalRow({
  signal,
  onSelect,
  demoMode = false,
}: {
  signal: FarmingControlRiskSignal;
  onSelect: () => void;
  demoMode?: boolean;
}) {
  const { t } = useLingui();
  const labels = useSeverityLabels();
  const severity = signal.severity;
  const status =
    signal.status === "action_required" ? t`Action required` : labels[severity ?? "unknown"];
  const value = signalValue(signal, status, demoMode);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex min-h-11 w-full items-center justify-between gap-3 border-t border-border/70 py-2.5 text-start first:border-t-0 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={`${t`View evidence: ${signal.label}, ${value}. ${status}.`}${signal.coverage === "partial" ? ` ${t`Partial evidence`}` : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2.5 text-xs">
        <span className={severityColor[severity ?? "unknown"]}>
          <SignalShape severity={severity} />
        </span>
        <span className="min-w-0 leading-relaxed">
          {signal.label}
          {signal.status === "action_required" && signal.value !== null ? (
            <span
              className={cn("ms-1.5 text-[10px]", severityColor[severity ?? "unknown"])}
            >{t`Action required`}</span>
          ) : null}
          {signal.coverage === "partial" ? (
            <span className="ms-1.5 text-[10px] text-muted-foreground">{t`Partial evidence`}</span>
          ) : null}
        </span>
        <span className="sr-only">{labels[severity ?? "unknown"]}</span>
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums",
          severityColor[severity ?? "unknown"],
        )}
      >
        {value}
        <ChevronRight size={11} className="text-muted-foreground/60" />
      </span>
    </button>
  );
}

function prioritizedSignals(exposure: FarmingControlRiskExposure) {
  const primary =
    exposure.kind === "pool"
      ? ["curve_flows_24h", "relative_peg", "executable_exit"]
      : exposure.kind === "market"
        ? ["exit_capacity", "liquidation_capacity", "utilization"]
        : ["withdrawal_capacity", "concentration", "risk_coverage"];
  const priority = (signal: FarmingControlRiskSignal) => {
    const severity = signal.severity;
    if (severity === "critical") return 0;
    if (severity === "warning") return 10;
    const primaryIndex = primary.indexOf(signal.family ?? signal.key);
    return primaryIndex >= 0 ? 20 + primaryIndex : severity === "info" ? 40 : 50;
  };
  return [...exposure.signals].sort((a, b) => priority(a) - priority(b));
}

function triagedExposures(exposures: FarmingControlRiskExposure[]) {
  const rank = { critical: 0, warning: 1, info: 2, unknown: 3 };
  return [...exposures].sort(
    (a, b) => rank[a.maxSeverity ?? "unknown"] - rank[b.maxSeverity ?? "unknown"],
  );
}

export function RiskCards({
  data,
  onMention,
  onReview,
  demoMode = false,
  mentionBusy = false,
  mentionError = null,
}: Props) {
  const { t } = useLingui();
  const labels = useSeverityLabels();
  const [selection, setSelection] = useState<{ exposureId: string; signalKey: string } | null>(
    null,
  );
  const exposure = data.exposures.find((item) => item.id === selection?.exposureId);
  const selectedSignal = exposure?.signals.find((item) => item.key === selection?.signalKey);
  const discovery = data.exposureScope.discovery;
  const uncovered = data.exposureScope.uncoveredPositionCount;
  return (
    <>
      {data.exposures.length > 0 && discovery !== "complete" ? (
        <p role="status" className="text-xs text-warning">
          <Trans>Exposure discovery is incomplete. Showing returned readings.</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-border pb-4">
        <h2 className="text-sm font-medium">
          <Trans>Pools, vaults & markets</Trans>
          <span className="ms-2 text-xs tabular-nums text-muted-foreground">
            {data.exposures.length}
          </span>
        </h2>
        <section
          aria-label={t`Risk signal legend`}
          className="flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-muted-foreground"
        >
          {(["info", "warning", "critical", null] as const).map((severity) => (
            <span key={severity ?? "unknown"} className="inline-flex items-center gap-1.5">
              <span className={severityColor[severity ?? "unknown"]}>
                <SignalShape severity={severity} />
              </span>
              {labels[severity ?? "unknown"]}
            </span>
          ))}
        </section>
      </div>
      {data.exposures.length ? (
        <section
          aria-label={t`Position risk signals`}
          className="grid grid-cols-1 gap-4 @3xl/farming:grid-cols-2"
        >
          {triagedExposures(data.exposures).map((item) => {
            const signals = prioritizedSignals(item);
            const compact = item.dataStatus !== "live" && item.maxSeverity === null;
            return (
              <Card
                key={item.id}
                className={cn(
                  "min-w-0 gap-0 py-0",
                  compact &&
                    "bg-muted/35 @3xl/farming:col-span-2 @3xl/farming:grid @3xl/farming:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] @3xl/farming:items-center",
                )}
                data-testid="farming-control-risk-card"
              >
                <div
                  className={cn(
                    "flex items-start gap-3 px-5 pt-5 pb-4",
                    compact && "@3xl/farming:py-4",
                  )}
                >
                  <div
                    aria-hidden="true"
                    className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  >
                    <Shield size={18} strokeWidth={1.5} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] leading-relaxed text-muted-foreground">
                      {item.protocol}
                      <span aria-hidden="true"> · </span>
                      {chainName(item.chainId, t`Chain ${item.chainId}`)}
                    </div>
                    <h3 className="mt-1 break-words text-lg font-medium tracking-tight">
                      {item.label}
                    </h3>
                    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      <Link2 aria-hidden="true" size={11} className="mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <span className="sr-only">{t`Linked positions`}: </span>
                        {item.positions.map((position) => position.label).join(" · ")}
                      </div>
                    </div>
                  </div>
                  <RiskGauge exposure={item} />
                </div>
                <CardContent
                  className={cn(
                    "px-5",
                    compact && "@3xl/farming:border-s @3xl/farming:border-border @3xl/farming:py-2",
                  )}
                >
                  {signals.length ? (
                    signals
                      .slice(0, 3)
                      .map((signal) => (
                        <SignalRow
                          key={signal.key}
                          demoMode={demoMode}
                          signal={signal}
                          onSelect={() =>
                            setSelection({ exposureId: item.id, signalKey: signal.key })
                          }
                        />
                      ))
                  ) : (
                    <div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
                      <SignalShape severity={null} />
                      <Trans>No current reading</Trans>
                    </div>
                  )}
                  {signals.length > 3 ? (
                    <details className="border-t border-border/70 text-xs">
                      <summary className="cursor-pointer py-3 text-muted-foreground">
                        {t`More signals`}{" "}
                        <span className="ms-1 tabular-nums">{signals.length - 3}</span>
                      </summary>
                      {signals.slice(3).map((signal) => (
                        <SignalRow
                          key={signal.key}
                          demoMode={demoMode}
                          signal={signal}
                          onSelect={() =>
                            setSelection({ exposureId: item.id, signalKey: signal.key })
                          }
                        />
                      ))}
                    </details>
                  ) : null}
                  <div
                    className={cn(
                      "flex items-center gap-1.5 pt-3 pb-4 text-[10px] text-muted-foreground",
                      compact && "@3xl/farming:hidden",
                    )}
                  >
                    <Clock3 aria-hidden="true" size={11} />
                    <ObservationTime value={item.observedAtMs} />
                  </div>
                </CardContent>
                <CardFooter
                  className={cn(
                    "mt-auto justify-between gap-3 px-5 py-2",
                    compact &&
                      "@3xl/farming:mt-0 @3xl/farming:border-t-0 @3xl/farming:bg-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "text-[10px] text-muted-foreground",
                      compact && "@3xl/farming:hidden",
                    )}
                  >
                    {item.coverage === "unknown" ? t`Coverage unknown` : t`Partial risk coverage`}
                  </span>
                  {onReview ? (
                    <Button variant="ghost" size="sm" onClick={() => onReview(item.monitorKey)}>
                      <Trans>History and interpretation</Trans>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mentionBusy}
                    onClick={() => void onMention(item)}
                    className="-me-2 text-xs"
                  >
                    <MessageSquare size={13} />
                    <Trans>Mention to agent</Trans>
                    <ArrowUpRight size={12} />
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </section>
      ) : (
        <Empty>
          {discovery === "unavailable"
            ? t`Risk exposure discovery is unavailable.`
            : discovery === "partial"
              ? t`Exposure discovery is incomplete. No matching readings returned.`
              : data.exposureScope.activePositionCount === 0
                ? t`No visible active positions.`
                : t`No matching pools, vaults or markets for visible active positions.`}
        </Empty>
      )}
      <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        {data.exposures.length ? (
          <p>
            <Trans>
              Gauges show the highest observed signal. Coverage remains partial; missing or stale
              readings stay gray.
            </Trans>
          </p>
        ) : null}
        {uncovered !== null && uncovered > 0 ? (
          <p>
            <Plural
              value={uncovered}
              one="# visible active position has no matching risk source."
              other="# visible active positions have no matching risk source."
            />
          </p>
        ) : null}
      </div>
      <Dialog
        open={Boolean(exposure && selectedSignal)}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        {exposure && selectedSignal ? (
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{selectedSignal.label}</DialogTitle>
              <DialogDescription>
                {exposure.protocol} · {exposure.label} ·{" "}
                {chainName(exposure.chainId, t`Chain ${exposure.chainId}`)}
              </DialogDescription>
            </DialogHeader>
            <div
              className={cn(
                "flex items-center gap-2 text-xl font-medium tabular-nums",
                severityColor[selectedSignal.severity ?? "unknown"],
              )}
            >
              <SignalShape severity={selectedSignal.severity} />
              {signalValue(
                selectedSignal,
                selectedSignal.status === "action_required"
                  ? t`Action required`
                  : labels[selectedSignal.severity ?? "unknown"],
                demoMode,
              )}
            </div>
            <p className="text-sm leading-relaxed">
              {demoMode ? t`Evidence summary hidden in demo` : selectedSignal.summary}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-xs">
              <dt className="text-muted-foreground">
                <Trans>Linked positions</Trans>
              </dt>
              <dd>{exposure.positions.map((position) => position.label).join(" · ")}</dd>
              <dt className="text-muted-foreground">
                <Trans>Observation</Trans>
              </dt>
              <dd>
                <ObservationTime value={exposure.observedAtMs} />
              </dd>
              <dt className="text-muted-foreground">
                <Trans>Assessment</Trans>
              </dt>
              <dd>
                {selectedSignal.status === "action_required"
                  ? t`Action required`
                  : labels[selectedSignal.severity ?? "unknown"]}
              </dd>
              {selectedSignal.status === "action_required" &&
              selectedSignal.severity === "warning" ? (
                <>
                  <dt className="text-muted-foreground">
                    <Trans>Severity</Trans>
                  </dt>
                  <dd>{labels.warning}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">
                <Trans>Signal coverage</Trans>
              </dt>
              <dd>
                {selectedSignal.coverage === "partial"
                  ? t`Partial evidence`
                  : selectedSignal.coverage === "current"
                    ? t`Current`
                    : t`No reading`}
              </dd>
              {exposure.blockNumber ? (
                <>
                  <dt className="text-muted-foreground">
                    <Trans>Block</Trans>
                  </dt>
                  <dd className="tabular-nums">{exposure.blockNumber}</dd>
                </>
              ) : null}
            </dl>
            {selectedSignal.metrics?.length ? (
              <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-3 border-t border-border pt-4 text-xs">
                {selectedSignal.metrics.map((metric) => (
                  <div key={metric.key} className="contents">
                    <dt className="text-muted-foreground">{metric.label}</dt>
                    <dd className="text-end tabular-nums">
                      {signalValue(metric, t`No reading`, demoMode)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {!demoMode && exposure.limitations.length ? (
              <div className="space-y-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                {exposure.limitations.map((limitation) => (
                  <p key={limitation}>{limitation}</p>
                ))}
              </div>
            ) : null}
            {mentionError ? (
              <p role="alert" className="text-xs text-destructive">
                {mentionError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={mentionBusy}
                onClick={() => void onMention(exposure, selectedSignal)}
              >
                <MessageSquare size={14} />
                <Trans>Mention to agent</Trans>
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

/** The same authenticated review the specialist reads, with no financial amount disclosure. */
export function RiskReviewEvidence({
  review,
  onSelect,
  onMention,
}: {
  review: FarmingControlRiskReview;
  onSelect: (monitorKey: string) => void;
  onMention: (monitorKey: string, label: string) => void;
}) {
  const { t } = useLingui();
  const health = {
    unknown: t`No reading`,
    healthy: t`Within limits`,
    attention: t`Watch`,
    action_required: t`Action required`,
  };
  const analysis = { pending: t`Pending`, failed: t`Failed`, indeterminate: t`Indeterminate` };
  const runLabels: Record<string, string> = {
    queued: t`Queued`,
    leased: t`Leased`,
    running: t`Running`,
    waiting_input: t`Waiting for input`,
    waiting_takeover: t`Waiting for takeover`,
    completed: t`Completed`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
  };
  const kinds = {
    emergency: t`Emergency`,
    material_trend: t`Trend review`,
    weekly_review: t`Weekly research`,
  };
  const transition = { opened: t`Opened`, updated: t`Updated`, resolved: t`Resolved` };
  const date = (value: number) => (
    <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString()}</time>
  );
  const selected = review.selectionStatus === "matched";
  const item = selected ? review.evidence?.items[0] : null;
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label={t`Monitoring history and interpretation`}
    >
      <h2 className="text-sm font-medium">
        <Trans>Monitoring history and interpretation</Trans>
      </h2>
      {!selected ? (
        <>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Includes monitors without proven holdings. Select a monitor for dated evidence.
            </Trans>
          </p>
          {review.evidence?.items.map((monitor) => (
            <Button
              key={monitor.monitorKey}
              variant="ghost"
              onClick={() => onSelect(monitor.monitorKey)}
            >
              {monitor.label} · {health[monitor.emergency.status]}
            </Button>
          ))}
          {!review.evidence?.items.length ? (
            <p className="text-xs">
              <Trans>No Monitoring evidence returned. Current risk remains unknown.</Trans>
            </p>
          ) : null}
        </>
      ) : item ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-medium">{item.label}</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMention(item.monitorKey, item.label)}
            >
              <Trans>Mention to agent</Trans>
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt>
              <Trans>Current FC state</Trans>
            </dt>
            <dd>
              {health[item.emergency.status]} ·{" "}
              {item.current.status === "live" ? t`Current` : t`No reading`}
            </dd>
            <dt>
              <Trans>Observation</Trans>
            </dt>
            <dd>
              <ObservationTime value={item.current.observedAtMs} />
            </dd>
            <dt>
              <Trans>Finality</Trans>
            </dt>
            <dd>
              <Trans>Not exposed by this evidence read</Trans>
            </dd>
            <dt>
              <Trans>Coverage</Trans>
            </dt>
            <dd>
              <Trans>Partial risk coverage</Trans>
            </dd>
            <dt>
              <Trans>Holding association</Trans>
            </dt>
            <dd>
              {review.exposureAssociationStatus === "matched_visible_holding"
                ? t`Matched visible holding`
                : t`Exposure not established`}
            </dd>
          </dl>
          <details className="text-xs" open>
            <summary className="cursor-pointer font-medium">
              <Trans>Dated episode history</Trans>
            </summary>
            <p className="my-2 text-muted-foreground">
              <Trans>
                History coverage is unknown. These records do not establish present health or
                delivery recovery.
              </Trans>
            </p>
            {review.episodeHistory?.transitions.length ? (
              <ol className="space-y-2">
                {review.episodeHistory.transitions.map((row) => (
                  <li
                    key={`${row.runtimeInstanceId}:${row.id}`}
                    className="border-s border-border ps-3"
                  >
                    <span className="font-medium">{transition[row.transition]}</span> ·{" "}
                    {date(row.occurredAtMs)}
                    <div className="text-muted-foreground">
                      {row.subjectKey} · {row.policyKey ?? t`Policy unknown`}
                    </div>
                    <div>
                      {t`Episode opened`}:{" "}
                      {row.episodeOpenedAtMs === null ? t`Unknown` : date(row.episodeOpenedAtMs)}
                    </div>
                    <div>
                      {t`Finality`}:{" "}
                      {row.finality === "finalized"
                        ? t`Finalized`
                        : row.finality === "latest"
                          ? t`Latest`
                          : t`Unknown`}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                <Trans>No retained transitions returned; past incidents remain unknown.</Trans>
              </p>
            )}
            {review.episodeHistory?.truncated ? (
              <p className="mt-2 text-warning">
                <Trans>History read is incomplete.</Trans>
              </p>
            ) : null}
          </details>
          <details className="text-xs" open>
            <summary className="cursor-pointer font-medium">
              <Trans>Risk interpretation</Trans>
            </summary>
            <p className="my-2 text-muted-foreground">
              <Trans>Completed runs remain indeterminate without final-output proof.</Trans>
            </p>
            {review.interpretations ? (
              <p className="my-2 text-muted-foreground">
                {t`Status observed`}: {date(review.interpretations.asOfMs)}
              </p>
            ) : null}
            {review.interpretations?.runs.length ? (
              <ul className="space-y-2">
                {review.interpretations.runs.map((run) => (
                  <li key={run.runId} className="border-s border-border ps-3">
                    <div>
                      {kinds[run.kind]} · {date(run.triggeredAtMs)} · {analysis[run.analysisStatus]}
                    </div>
                    <div className="text-muted-foreground">
                      {t`Run status`}: {runLabels[run.runStatus ?? ""] ?? t`Unknown`}
                    </div>
                    {run.subjectKey ? (
                      <div className="text-muted-foreground">
                        {run.subjectKey} · {run.policyKey ?? t`Policy unknown`}
                      </div>
                    ) : null}
                    {run.scope === "monitoring_universe" ? (
                      <div>
                        <Trans>Monitoring-wide research; not a selected episode result.</Trans>
                      </div>
                    ) : null}
                    {run.occurredAtMs !== null ? (
                      <div>
                        {t`Event time`}: {date(run.occurredAtMs)} ·{" "}
                        {run.transition ? transition[run.transition] : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                <Trans>No correlated Risk run returned. Analysis availability is unknown.</Trans>
              </p>
            )}
            {review.interpretations?.truncated ? (
              <p className="mt-2 text-warning">
                <Trans>Run history read is incomplete.</Trans>
              </p>
            ) : null}
          </details>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              <Trans>Sources and coverage</Trans>
            </summary>
            {review.sources.map((source) => (
              <div key={source} className="break-all font-mono">
                {source}
              </div>
            ))}
            <div>
              {t`Fetched`}: {date(review.fetchedAtMs)}
            </div>
            {review.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
          </details>
        </>
      ) : (
        <p>
          <Trans>The selected monitor is unavailable. Current risk remains unknown.</Trans>
        </p>
      )}
    </section>
  );
}
