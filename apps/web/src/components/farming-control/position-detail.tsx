import { Trans, useLingui } from "@lingui/react/macro";
import type {
  FarmingControlPortfolio,
  FarmingControlPositionDetail,
  FarmingControlPositionHistory,
  FarmingControlRiskExposure,
  FarmingControlRiskSignal,
} from "@rakazo/contracts";
import { Badge, Button, Card, CardContent, cn, Skeleton } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquare, Shield } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { FarmingControlAskContext } from "./card-context";
import { riskCardContext } from "./card-context";
import { PositionHistoryCharts } from "./position-detail-charts";
import {
  presentPositionDetailAmounts,
  presentPositionHistoryAmounts,
} from "./position-detail-demo";
import { Empty, exactAmount, exactPercent, Section } from "./presentation";

type Position = FarmingControlPortfolio["positions"][number];
type Detail = Extract<FarmingControlPositionDetail, { status: "matched" }>;
type History = Extract<FarmingControlPositionHistory, { status: "matched" }>;
type Props = {
  position: Position;
  demoSeed: string | null;
  queryScope: string;
  rpc: RpcClient;
  walletVisibilityRevision: number | null;
  coordinatorId?: string;
  ask: (context: FarmingControlAskContext) => Promise<void>;
};
const short = (value: string) =>
  value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
const safeUrl = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};
function date(value: number | null, detailed = false) {
  return value === null
    ? "—"
    : new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...(detailed
          ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone: "UTC" }
          : {}),
      });
}
function Explorer({ href, label }: { href: string | null | undefined; label: string }) {
  const url = safeUrl(href);
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ArrowUpRight size={14} />
    </a>
  ) : null;
}
function OverviewMetric({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 break-words text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
      {children ? (
        <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}
function EvidenceNotice({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

/** Read-only consumer of the position evidence API; presentation never becomes chat/accounting input. */
export function PositionDetail({
  position,
  demoSeed,
  queryScope,
  rpc,
  walletVisibilityRevision,
  coordinatorId,
  ask,
}: Props) {
  const { t } = useLingui();
  const queryKey = ["farming-control", queryScope, "position", position.id];
  const options = { staleTime: 30_000, retry: false } as const;
  const detailQuery = useQuery({
    queryKey: [...queryKey, "detail", walletVisibilityRevision],
    queryFn: ({ signal }) =>
      rpc.farmingControl.positionDetail({ positionId: position.id }, { signal }),
    ...options,
  });
  const historyQuery = useQuery({
    queryKey: [...queryKey, "history", walletVisibilityRevision, "since_opening"],
    queryFn: ({ signal }) =>
      rpc.farmingControl.positionHistory(
        { positionId: position.id, period: "since_opening" },
        { signal },
      ),
    ...options,
  });
  const riskQuery = useQuery({
    queryKey: [...queryKey, "risk", walletVisibilityRevision],
    queryFn: ({ signal }) => rpc.farmingControl.risk(undefined, { signal }),
    ...options,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const entityQuery = useQuery({
    queryKey: [...queryKey, "entities", coordinatorId, walletVisibilityRevision],
    queryFn: ({ signal }) =>
      rpc.farmingControl.mentionTargets(
        {
          botId: coordinatorId!,
          positionId: position.id,
          kinds: ["wallet", "protocol"],
          limit: 100,
        },
        { signal },
      ),
    enabled: Boolean(coordinatorId),
    ...options,
  });
  const sameScope = (revision: number | null) =>
    walletVisibilityRevision !== null && revision === walletVisibilityRevision;
  const canonicalDetail =
    detailQuery.data?.status === "matched" &&
    detailQuery.data.positionId === position.id &&
    sameScope(detailQuery.data.walletVisibilityRevision)
      ? detailQuery.data
      : null;
  const canonicalHistory =
    historyQuery.data?.status === "matched" &&
    historyQuery.data.positionId === position.id &&
    sameScope(historyQuery.data.walletVisibilityRevision)
      ? historyQuery.data
      : null;
  const projectedDetail = useMemo(
    () =>
      canonicalDetail && demoSeed !== null
        ? presentPositionDetailAmounts(canonicalDetail, demoSeed, position)
        : canonicalDetail,
    [canonicalDetail, demoSeed, position],
  );
  const detail = projectedDetail?.status === "matched" ? projectedDetail : null;
  const projectedHistory = useMemo(
    () =>
      canonicalHistory && demoSeed !== null
        ? presentPositionHistoryAmounts(canonicalHistory, demoSeed, position)
        : canonicalHistory,
    [canonicalHistory, demoSeed, position],
  );
  const history = projectedHistory?.status === "matched" ? projectedHistory : null;
  const entities =
    entityQuery.data && sameScope(entityQuery.data.walletVisibilityRevision)
      ? entityQuery.data.entities.filter((entity) => entity.positionIds.includes(position.id))
      : [];
  const risk =
    riskQuery.data && sameScope(riskQuery.data.exposureScope.walletVisibilityRevision)
      ? riskQuery.data
      : null;
  const exposures =
    risk?.exposures.filter((item) => item.positions.some((linked) => linked.id === position.id)) ??
    [];
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  async function requestAsk(context: FarmingControlAskContext) {
    if (askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      await ask({ ...context, positionId: position.id });
    } catch (error) {
      setAskError(demoSeed === null ? errorText(error) : t`Unable to open the question draft.`);
    } finally {
      setAskBusy(false);
    }
  }
  const askButton = (label: string, owner: FarmingControlAskContext["owner"] = "coordinator") => (
    <Button
      variant="ghost"
      size="sm"
      className="-me-2 h-7 text-xs"
      disabled={askBusy}
      aria-label={t`Ask about ${label}`}
      onClick={() =>
        void requestAsk({
          owner,
          entityType: "position",
          entityId: position.id,
          positionId: position.id,
          label: position.label ?? position.id,
        })
      }
    >
      <MessageSquare size={13} />
      <Trans>Ask</Trans>
    </Button>
  );
  const scopeError =
    walletVisibilityRevision === null
      ? t`Wallet display scope is unavailable.`
      : t`Wallet display scope changed. Refresh this position.`;
  const detailError = detailQuery.error
    ? demoSeed === null
      ? errorText(detailQuery.error)
      : t`Position details unavailable.`
    : detailQuery.data?.status === "unavailable"
      ? demoSeed === null
        ? detailQuery.data.reason
        : t`Position details unavailable.`
      : detailQuery.data && !canonicalDetail
        ? scopeError
        : null;
  const historyError = historyQuery.error
    ? demoSeed === null
      ? errorText(historyQuery.error)
      : t`History unavailable.`
    : historyQuery.data?.status === "unavailable"
      ? demoSeed === null
        ? historyQuery.data.reason
        : t`History unavailable.`
      : historyQuery.data && !canonicalHistory
        ? scopeError
        : null;
  const monthly = history?.earnings?.economicScorecard.monthlyAverage;
  const baseline = position.current.capitalBaselineUsd;
  const currentRate = position.apr;
  const freshness = (value: string) =>
    value === "current"
      ? t`Current`
      : value === "stale"
        ? t`Stale observation`
        : t`Freshness unknown`;
  return (
    <div className="space-y-4" data-testid="farming-control-position-detail">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{position.state}</Badge>
        {position.adapter.key ? <span>{position.adapter.key}</span> : null}
        {position.assetSetKeys?.map((key) => (
          <Badge key={key} variant="secondary">
            {key}
          </Badge>
        ))}
      </div>
      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          <dl className="grid grid-cols-2 divide-x divide-border @3xl/farming:grid-cols-4">
            <OverviewMetric
              label={t`Position value`}
              value={exactAmount(position.current.valueUsd)}
            >
              {freshness(position.dataQuality.valueFreshness)}
            </OverviewMetric>
            <OverviewMetric
              label={currentRate?.rateType === "apy" ? t`Current APY` : t`Current APR`}
              value={exactPercent(currentRate?.percentPerYear)}
            >
              {freshness(position.dataQuality.aprFreshness)}
              {currentRate?.projectionOnly ? ` · ${t`Projection only`}` : ""}
            </OverviewMetric>
            <OverviewMetric
              label={t`Earned · closed months`}
              value={
                historyQuery.isPending ? (
                  <Skeleton className="h-8 w-24" />
                ) : (
                  exactAmount(monthly?.summedEarnedUsd)
                )
              }
            >
              {monthly
                ? t`${monthly.includedMonths.length} supported months`
                : t`Historical accrual`}
            </OverviewMetric>
            <OverviewMetric
              label={t`Wallets`}
              value={
                <span className="text-sm font-medium">
                  {detail
                    ? detail.wallets.length
                      ? detail.wallets
                          .map((wallet) => wallet.label || short(wallet.address))
                          .join(" · ")
                      : t`Not attributed`
                    : detailQuery.isPending
                      ? t`Loading…`
                      : "—"}
                </span>
              }
            >
              <span className="inline-flex flex-wrap items-center gap-1">
                {detail?.opening ? (
                  <>
                    <span>
                      {detail.opening.kind === "position.open"
                        ? t`Opened`
                        : t`First deposit evidence`}{" "}
                      {date(detail.opening.occurredAtMs)}
                    </span>
                    <Explorer
                      href={detail.opening.transaction?.explorerUrl}
                      label={t`View opening transaction`}
                    />
                  </>
                ) : (
                  openingFallback(
                    history,
                    t`Tracked since`,
                    t`First confirmed deposit`,
                    t`First saved rate`,
                    t`Opening evidence unavailable`,
                  )
                )}
              </span>
            </OverviewMetric>
          </dl>
        </CardContent>
      </Card>
      {askError ? (
        <p role="alert" className="text-xs text-destructive">
          {demoSeed === null ? askError : t`Unable to open the question draft.`}
        </p>
      ) : null}
      <PositionHistoryCharts
        history={history}
        loading={historyQuery.isPending}
        error={historyError}
      />
      <div className="grid min-w-0 gap-4 @3xl/farming:grid-cols-2">
        <Section title={t`Position monitoring`} action={askButton(t`Position monitoring`, "risk")}>
          {riskQuery.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : riskQuery.error ? (
            <EvidenceNotice>
              {demoSeed === null ? errorText(riskQuery.error) : t`Monitoring unavailable.`}
            </EvidenceNotice>
          ) : !risk ? (
            <EvidenceNotice>{scopeError}</EvidenceNotice>
          ) : exposures.length ? (
            <div className="space-y-4">
              {exposures.map((exposure) => (
                <CompactMonitoring
                  key={exposure.id}
                  exposure={exposure}
                  demo={demoSeed !== null}
                  busy={askBusy}
                  onAsk={(signal) =>
                    void requestAsk({
                      ...riskCardContext(exposure, signal),
                      positionId: position.id,
                    })
                  }
                />
              ))}
              {risk.exposureScope.discovery !== "complete" ? (
                <EvidenceNotice>
                  <Trans>Exposure discovery is incomplete.</Trans>
                </EvidenceNotice>
              ) : null}
            </div>
          ) : (
            <EvidenceNotice>
              {risk.exposureScope.discovery === "unavailable"
                ? t`Monitoring discovery unavailable.`
                : risk.exposureScope.discovery === "partial"
                  ? t`No matching readings returned. Discovery is incomplete.`
                  : t`No matching monitoring source for this position.`}
            </EvidenceNotice>
          )}
        </Section>
        <Section title={t`Rewards`} action={askButton(t`Position rewards`, "operations")}>
          {detailQuery.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : !detail ? (
            <EvidenceNotice>{detailError ?? t`Rewards unavailable.`}</EvidenceNotice>
          ) : (
            <>
              {detail.rewards.items.length ? (
                <div className="divide-y divide-border">
                  {detail.rewards.items.map((reward) => (
                    <div
                      key={reward.id}
                      className="flex items-start justify-between gap-4 py-2.5 first:pt-0"
                    >
                      <div className="min-w-0">
                        <div className="break-words text-sm font-medium">
                          {reward.symbol ?? (reward.token ? short(reward.token) : t`Reward`)}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {reward.quality === "current"
                            ? t`Current quantity`
                            : reward.quality === "fallback"
                              ? t`Last known quantity`
                              : reward.quality === "invalidated"
                                ? t`Invalidated reading`
                                : t`Quantity unknown`}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {date(reward.observedAtMs, true)}
                        </div>
                      </div>
                      <div className="max-w-[60%] break-all text-end text-sm tabular-nums">
                        {reward.amount ?? "—"}
                        {reward.symbol ? ` ${reward.symbol}` : ""}
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {demoSeed === null
                            ? reward.readiness.replaceAll("_", " ")
                            : t`Demo quantity`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EvidenceNotice>
                  {detail.rewards.state === "unavailable"
                    ? t`Reward evidence unavailable.`
                    : t`No recorded reward quantities.`}
                </EvidenceNotice>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                {detail.harvesting.mode === "manual"
                  ? t`Manual harvesting`
                  : detail.harvesting.mode === "auto"
                    ? t`Auto-compounding`
                    : detail.harvesting.mode === "mixed"
                      ? t`Mixed harvesting modes`
                      : t`Harvesting mode unknown`}
                {!detail.rewards.complete || detail.rewards.truncated
                  ? ` · ${t`Partial reward coverage`}`
                  : ""}
              </p>
            </>
          )}
        </Section>
      </div>
      <PositionTransactions
        detail={detail}
        history={history}
        loading={detailQuery.isPending}
        error={detailError}
        ask={askButton(t`Position transactions`)}
      />
      <Section title={t`Position details`}>
        <div className="grid gap-5 @xl/farming:grid-cols-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-xs">
            <dt className="text-muted-foreground">
              <Trans>Capital baseline</Trans>
            </dt>
            <dd className="text-end tabular-nums">{exactAmount(baseline)}</dd>
            <dt className="text-muted-foreground">
              <Trans>Projected 30d yield</Trans>
            </dt>
            <dd className="text-end tabular-nums">
              {exactAmount(position.projectedRewards?.usd?.month)}
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Value observation</Trans>
            </dt>
            <dd className="text-end">{date(position.current.observedAtMs, true)}</dd>
            <dt className="text-muted-foreground">
              <Trans>Rate observation</Trans>
            </dt>
            <dd className="text-end">{date(currentRate?.observedAtMs ?? null, true)}</dd>
            {demoSeed === null && currentRate?.source ? (
              <>
                <dt className="text-muted-foreground">
                  <Trans>Rate source</Trans>
                </dt>
                <dd className="break-words text-end">{currentRate.source}</dd>
              </>
            ) : null}
            {demoSeed === null && currentRate?.window ? (
              <>
                <dt className="text-muted-foreground">
                  <Trans>Rate window</Trans>
                </dt>
                <dd className="break-words text-end">{currentRate.window}</dd>
              </>
            ) : null}
          </dl>
          <div className="min-w-0 space-y-3">
            {detail?.wallets.map((wallet) => {
              const entity = entities.find(
                (item) =>
                  item.selection.kind === "wallet" &&
                  item.selection.id.toLowerCase() === wallet.address.toLowerCase(),
              );
              return (
                <div
                  key={wallet.address}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs">{wallet.label}</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {wallet.address}
                    </div>
                  </div>
                  <div className="flex items-center">
                    <Explorer
                      href={`https://blockscan.com/address/${wallet.address}`}
                      label={t`View wallet in explorer`}
                    />
                    {entity ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={askBusy}
                        onClick={() =>
                          void requestAsk({
                            owner: "coordinator",
                            entityType: "wallet",
                            entityId: entity.selection.id,
                            label: entity.label,
                          })
                        }
                      >
                        <MessageSquare size={13} />
                        <Trans>Ask</Trans>
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {entities
              .filter((entity) => entity.selection.kind === "protocol")
              .map((entity) => (
                <div
                  key={entity.selection.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span>{entity.label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={askBusy}
                    onClick={() =>
                      void requestAsk({
                        owner: "coordinator",
                        entityType: "protocol",
                        entityId: entity.selection.id,
                        label: entity.label,
                      })
                    }
                  >
                    <MessageSquare size={13} />
                    <Trans>Ask</Trans>
                  </Button>
                </div>
              ))}
            {detail && !detail.walletsComplete ? (
              <EvidenceNotice>
                <Trans>Wallet attribution is incomplete.</Trans>
              </EvidenceNotice>
            ) : null}
          </div>
        </div>
        <Coverage detail={detail} history={history} demo={demoSeed !== null} />
      </Section>
    </div>
  );
}

function CompactMonitoring({
  exposure,
  demo,
  busy,
  onAsk,
}: {
  exposure: FarmingControlRiskExposure;
  demo: boolean;
  busy: boolean;
  onAsk: (signal?: FarmingControlRiskSignal) => void;
}) {
  const { t } = useLingui();
  const labels = {
    info: t`Within limits`,
    warning: t`Watch`,
    critical: t`Action required`,
    unknown: t`No current reading`,
  };
  const colors = {
    info: "text-success",
    warning: "text-warning",
    critical: "text-destructive",
    unknown: "text-muted-foreground",
  };
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <Shield
            size={17}
            className={cn("mt-0.5 shrink-0", colors[exposure.maxSeverity ?? "unknown"])}
          />
          <div>
            <h3 className="break-words text-sm font-medium">{exposure.label}</h3>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {exposure.coverage === "unknown" ? t`Coverage unknown` : t`Partial coverage`} ·{" "}
              {exposure.dataStatus.replaceAll("_", " ")}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => onAsk()}
        >
          <MessageSquare size={12} />
          <Trans>Ask</Trans>
        </Button>
      </div>
      <div className="divide-y divide-border">
        {exposure.signals.length ? (
          exposure.signals.slice(0, 3).map((signal) => (
            <details key={signal.key} className="text-xs">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">{signal.label}</span>
                <span className={cn("shrink-0 text-[11px]", colors[signal.severity ?? "unknown"])}>
                  {signal.status === "action_required"
                    ? t`Action required`
                    : labels[signal.severity ?? "unknown"]}
                </span>
              </summary>
              <div className="pb-3">
                {demo ? (
                  <p className="text-muted-foreground">
                    {signal.coverage === "current"
                      ? t`Current evidence`
                      : signal.coverage === "partial"
                        ? t`Partial evidence`
                        : t`No current evidence`}
                  </p>
                ) : (
                  <p className="leading-relaxed text-muted-foreground">{signal.summary}</p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-7 px-0 text-xs"
                  disabled={busy}
                  onClick={() => onAsk(signal)}
                >
                  <MessageSquare size={12} />
                  <Trans>Ask about signal</Trans>
                </Button>
              </div>
            </details>
          ))
        ) : (
          <EvidenceNotice>
            <Trans>No current reading.</Trans>
          </EvidenceNotice>
        )}
      </div>
      {exposure.signals.length > 3 ? (
        <details className="text-xs">
          <summary className="cursor-pointer py-2 text-muted-foreground">
            {t`More signals`} ({exposure.signals.length - 3})
          </summary>
          <div className="divide-y divide-border">
            {exposure.signals.slice(3).map((signal) => (
              <div key={signal.key} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {signal.label}
                  <span className={cn("ms-2 text-[11px]", colors[signal.severity ?? "unknown"])}>
                    {labels[signal.severity ?? "unknown"]}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onAsk(signal)}
                  aria-label={t`Ask about ${signal.label}`}
                >
                  <MessageSquare size={12} />
                  <Trans>Ask</Trans>
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {exposure.observedAtMs === null
          ? t`No current observation`
          : t`Observed ${date(exposure.observedAtMs, true)}`}
      </p>
    </div>
  );
}

function PositionTransactions({
  detail,
  history,
  loading,
  error,
  ask,
}: {
  detail: Detail | null;
  history: History | null;
  loading: boolean;
  error: string | null;
  ask: ReactNode;
}) {
  const { t } = useLingui();
  const [filter, setFilter] = useState<"all" | "reward" | "transfer">("all");
  const rows =
    detail?.activities.items.filter(
      (item) =>
        filter === "all" ||
        (filter === "reward"
          ? item.kind.startsWith("reward.")
          : item.kind === "position.open" ||
            item.kind === "deposit" ||
            item.kind === "withdrawal" ||
            item.kind === "position.close"),
    ) ?? [];
  return (
    <Section title={t`Transactions`} action={ask}>
      <fieldset className="mb-4 flex flex-wrap gap-1" aria-label={t`Transaction filter`}>
        {(["all", "reward", "transfer"] as const).map((value) => (
          <Button
            key={value}
            variant={filter === value ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? t`All activity` : value === "reward" ? t`Rewards` : t`Transfers`}
          </Button>
        ))}
      </fieldset>
      {loading ? (
        <Skeleton className="h-32 w-full" />
      ) : !detail ? (
        <EvidenceNotice>{error ?? t`Transaction evidence unavailable.`}</EvidenceNotice>
      ) : rows.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead className="hidden text-[11px] text-muted-foreground @xl/farming:table-header-group">
                <tr>
                  <th className="pb-2 text-start font-normal">
                    <Trans>Date · UTC</Trans>
                  </th>
                  <th className="pb-2 text-start font-normal">
                    <Trans>Action</Trans>
                  </th>
                  <th className="pb-2 text-end font-normal">
                    <Trans>Amount</Trans>
                  </th>
                  <th className="pb-2 text-end font-normal">
                    <Trans>Explorer</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 border-t border-border py-3 @xl/farming:table-row"
                  >
                    <td className="col-span-2 text-[11px] text-muted-foreground @xl/farming:py-3 @xl/farming:pe-4">
                      {row.occurredAtMs === null
                        ? t`Date not recorded`
                        : date(row.occurredAtMs, true)}
                    </td>
                    <td className="@xl/farming:py-3 @xl/farming:pe-4">
                      <div className="font-medium">
                        {row.kind.replaceAll(".", " ").replaceAll("_", " ")}
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {row.status.replaceAll("_", " ")} ·{" "}
                        {row.sourceId === "operator"
                          ? t`Operator record`
                          : row.sourceId === "onchain"
                            ? t`On-chain record`
                            : t`Source record`}
                      </div>
                    </td>
                    <td className="max-w-64 break-all text-end tabular-nums @xl/farming:py-3">
                      {row.amount !== null
                        ? `${row.amount}${row.token ? ` ${short(row.token)}` : ""}`
                        : (disposalAmount(history, row.id, t`proceeds`) ?? t`Amount not recorded`)}
                    </td>
                    <td className="col-start-2 text-end @xl/farming:py-3">
                      <Explorer
                        href={row.transaction?.explorerUrl}
                        label={t`View transaction in explorer`}
                      />
                      {!row.transaction?.explorerUrl ? (
                        <span className="text-[10px] text-muted-foreground">
                          {t`Link unavailable`}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t`${rows.length} records`}
            {!detail.activities.complete || detail.activities.truncated
              ? ` · ${t`Partial ledger`}`
              : ""}
          </p>
        </>
      ) : (
        <Empty>
          {detail.activities.state === "unavailable"
            ? t`Transaction evidence unavailable.`
            : t`No matching activity records.`}
        </Empty>
      )}
    </Section>
  );
}

function Coverage({
  detail,
  history,
  demo,
}: {
  detail: Detail | null;
  history: History | null;
  demo: boolean;
}) {
  const { t } = useLingui();
  return (
    <details className="mt-5 border-t border-border pt-4 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        <Trans>Coverage & provenance</Trans>
      </summary>
      <div className="mt-3 space-y-2 leading-relaxed text-muted-foreground">
        <p>
          <Trans>Quoted rates, monthly accrual and realized disposals are separate measures.</Trans>
        </p>
        <p>
          {detail
            ? detail.activities.complete
              ? t`Returned activity ledger complete.`
              : t`Activity ledger coverage is partial.`
            : t`Position evidence unavailable.`}
        </p>
        {history ? (
          <>
            <p>
              {history.trend.retrievalComplete && !history.trend.truncated
                ? t`Saved rate retrieval complete.`
                : t`Saved rate retrieval incomplete.`}
            </p>
            <p>
              {history.earnings?.economicScorecard.monthlyAverage.missingFullMonthCount
                ? t`${history.earnings.economicScorecard.monthlyAverage.missingFullMonthCount} full months lack supported earnings.`
                : t`Only supported full months contribute to the earnings total.`}
            </p>
            <p>
              <Trans>Recorded evidence does not establish complete lifetime earnings.</Trans>
            </p>
          </>
        ) : null}
        {!demo
          ? [
              ...(detail?.issues ?? []),
              ...(history?.trend.issues ?? []),
              ...(history?.earnings?.issues ?? []),
            ].map((issue, index) => <p key={`${index}:${issue}`}>{issue}</p>)
          : null}
        {!demo && detail?.sources.length ? (
          <p className="break-words">
            {t`Sources`}: {detail.sources.join(" · ")}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function disposalAmount(history: History | null, activityId: string, proceedsLabel: string) {
  const entry = history?.earnings?.harvest.entries.find((item) => item.activityId === activityId);
  if (!entry) return null;
  return entry.destination?.amountDecimal != null && entry.destination.symbol
    ? `${entry.destination.amountDecimal} ${entry.destination.symbol} ${proceedsLabel}`
    : `${exactAmount(entry.realizedUsd)} ${proceedsLabel}`;
}
function openingFallback(
  history: History | null,
  tracked: string,
  deposited: string,
  savedRate: string,
  unknown: string,
) {
  if (!history || history.startEvidence.atMs === null) return unknown;
  const kind = history.startEvidence.kind;
  const label =
    kind === "tracking_started"
      ? tracked
      : kind === "confirmed_deposit"
        ? deposited
        : kind === "first_saved_rate"
          ? savedRate
          : null;
  return label ? `${label} ${date(history.startEvidence.atMs)}` : unknown;
}
