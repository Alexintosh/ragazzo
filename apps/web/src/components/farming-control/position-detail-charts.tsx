import { Trans, useLingui } from "@lingui/react/macro";
import type { FarmingControlPositionHistory } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import type { PointerEvent } from "react";
import { useState } from "react";
import { compareExactAmounts, Empty, exactAmount, exactPercent, Section } from "./presentation";

type History = Extract<FarmingControlPositionHistory, { status: "matched" }>;
type Point = { id: string; at: number; value: string | null; label: string; method: string };
const monthLabel = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const dateLabel = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    timeZoneName: "short",
  });

function HistoryChart({
  points,
  bars,
  label,
  maximumGapMs = 40 * 86_400_000,
  dayLabels = false,
}: {
  points: Point[];
  bars: boolean;
  label: string;
  maximumGapMs?: number;
  dayLabels?: boolean;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<string | null>(null);
  const known = points.filter(
    (point) => point.value !== null && Number.isFinite(Number(point.value)),
  );
  if (!known.length)
    return (
      <Empty>
        <Trans>No supported history in this period.</Trans>
      </Empty>
    );
  const selection = points.find((point) => point.id === selected) ?? known.at(-1)!;
  const selectedIndex = points.indexOf(selection);
  // Number conversion is confined to geometry; displayed source amounts retain exact decimals.
  const lowest = known.reduce((best, point) =>
    compareExactAmounts(point.value, best.value, "ascending") < 0 ? point : best,
  );
  const highest = known.reduce((best, point) =>
    compareExactAmounts(point.value, best.value, "ascending") > 0 ? point : best,
  );
  const minimum = bars ? Math.min(0, Number(lowest.value)) : Number(lowest.value);
  const maximum = bars ? Math.max(0, Number(highest.value)) : Number(highest.value);
  const span = maximum - minimum;
  const from = points[0]!.at;
  const duration = points.at(-1)!.at - from || 1;
  const x = (point: Point) =>
    bars
      ? 50 + ((points.indexOf(point) + 0.5) / points.length) * 890
      : points.length === 1
        ? 495
        : 50 + ((point.at - from) / duration) * 890;
  const y = (value: number) => (span === 0 ? 103 : 173 - ((value - minimum) / span) * 140);
  const format = (value: string | null) =>
    value === null ? t`No reading` : bars ? exactAmount(value) : exactPercent(value);
  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - bounds.left) / bounds.width) * 1000;
    const nearest = points.reduce((best, point) =>
      Math.abs(x(point) - position) < Math.abs(x(best) - position) ? point : best,
    );
    setSelected(nearest.id);
  };
  const barWidth = Math.min(72, 600 / points.length);
  return (
    <figure className="m-0">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3 text-xs tabular-nums">
        <time dateTime={new Date(selection.at).toISOString()} className="text-muted-foreground">
          {bars ? monthLabel(selection.at) : dateLabel(selection.at)}
        </time>
        <span className="text-end font-medium">
          {format(selection.value)}
          {!bars && selection.value !== null ? ` ${selection.label}` : null}
        </span>
      </div>
      <div className="relative rounded ps-16 focus-within:ring-2 focus-within:ring-ring">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-8 start-0 flex w-14 flex-col justify-between text-end text-xs text-muted-foreground tabular-nums"
        >
          <span>{format(bars && maximum === 0 ? "0" : highest.value)}</span>
          <span>{format(bars && minimum === 0 ? "0" : lowest.value)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={points.length - 1}
          step={1}
          value={selectedIndex}
          onChange={(event) => setSelected(points[Number(event.currentTarget.value)]!.id)}
          aria-label={label}
          aria-valuetext={`${bars ? monthLabel(selection.at) : dateLabel(selection.at)}: ${format(selection.value)} ${bars ? "" : selection.label}`}
          className="sr-only"
        />
        <svg
          viewBox="0 0 1000 210"
          preserveAspectRatio="none"
          className="h-48 w-full touch-pan-y overflow-visible"
          aria-hidden="true"
          onPointerDown={selectPointer}
          onPointerMove={(event) => {
            if (event.pointerType === "mouse" || event.buttons) selectPointer(event);
          }}
        >
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              x1="50"
              x2="940"
              y1={33 + ratio * 140}
              y2={33 + ratio * 140}
              className="stroke-border"
              strokeDasharray="3 6"
            />
          ))}
          {bars ? <line x1="50" x2="940" y1={y(0)} y2={y(0)} className="stroke-border" /> : null}
          {points.map((point, index) => {
            const value =
              point.value === null || !Number.isFinite(Number(point.value))
                ? null
                : Number(point.value);
            const previous = points[index - 1];
            const connected =
              !bars &&
              value !== null &&
              previous?.value != null &&
              Number.isFinite(Number(previous.value)) &&
              previous.method === point.method &&
              point.at - previous.at <= maximumGapMs;
            return (
              <g key={point.id}>
                {connected ? (
                  <line
                    x1={x(previous!)}
                    y1={y(Number(previous!.value))}
                    x2={x(point)}
                    y2={y(value!)}
                    className="stroke-foreground/70"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                {value === null ? (
                  <path
                    d={`M${x(point) - 4} 168l8 8m0-8-8 8`}
                    className="stroke-muted-foreground"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : bars ? (
                  <rect
                    x={x(point) - barWidth / 2}
                    y={Math.min(y(0), y(value))}
                    width={barWidth}
                    height={Math.max(2, Math.abs(y(0) - y(value)))}
                    rx="3"
                    className={
                      selection.id === point.id ? "fill-foreground/80" : "fill-foreground/45"
                    }
                  />
                ) : (
                  <circle
                    cx={x(point)}
                    cy={y(value)}
                    r={selection.id === point.id ? 5 : 3}
                    className="fill-background stroke-foreground/70"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
          <line
            x1={x(selection)}
            x2={x(selection)}
            y1="26"
            y2="180"
            className="stroke-muted-foreground/50"
            strokeDasharray="3 6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <figcaption className="flex justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {dayLabels
            ? new Date(points[0]!.at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })
            : monthLabel(points[0]!.at)}
        </span>
        <span>
          {dayLabels
            ? new Date(points.at(-1)!.at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })
            : monthLabel(points.at(-1)!.at)}
        </span>
      </figcaption>
    </figure>
  );
}

export function PositionHistoryCharts({
  history,
  loading,
  error,
}: {
  history: History | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useLingui();
  const [aprPeriod, setAprPeriod] = useState<"7d" | "30d" | "all">("all");
  const [earningsPeriod, setEarningsPeriod] = useState<"latest" | "all">("all");
  const months = history?.trend.months ?? [];
  const nativePoints = history?.trend.chartPoints;
  const monthlyPoints: Point[] = months.flatMap<Point>((month) => {
    const rates = [month.firstRate, month.lastRate].filter((point) => point !== null);
    const unique = rates.filter(
      (point, index) =>
        rates.findIndex((other) => other.observationId === point.observationId) === index,
    );
    return unique.length
      ? unique.map((point) => ({
          id: point.observationId,
          at: point.observedAtMs,
          value: point.percentPerYear,
          label: point.rateType.toUpperCase(),
          method: JSON.stringify([
            point.rateType,
            point.source,
            point.window,
            point.adapterVersion,
          ]),
        }))
      : [{ id: month.month, at: month.fromMs, value: null, label: "", method: "" }];
  });
  const rawPoints: Point[] = nativePoints?.length
    ? nativePoints.map((point) => ({
        id: point.observationId,
        at: point.observedAtMs,
        value: point.percentPerYear,
        label: point.rateType.toUpperCase(),
        method: JSON.stringify([point.rateType, point.source, point.window, point.adapterVersion]),
      }))
    : monthlyPoints;
  const cutoff =
    !history || aprPeriod === "all"
      ? 0
      : history.requestedThroughMs - (aprPeriod === "7d" ? 7 : 30) * 86_400_000;
  const points = rawPoints
    .filter(
      (point, index) =>
        point.at >= cutoff && rawPoints.findIndex((other) => other.id === point.id) === index,
    )
    .sort((a, b) => a.at - b.at);
  const earnedMonths = history?.earnings?.monthlyRecovery.months ?? [];
  const visibleEarned = earningsPeriod === "latest" ? earnedMonths.slice(-6) : earnedMonths;
  const earnings: Point[] = visibleEarned.map((month) => ({
    id: month.month,
    at: month.fromMs,
    value:
      month.completeCalendarMonth && month.state === "available"
        ? (month.contribution?.earnedUsd ?? null)
        : null,
    label: "",
    method: "earned",
  }));
  const control = (
    <fieldset className="flex gap-1" aria-label={t`APR history period`}>
      {(["7d", "30d", "all"] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant={aprPeriod === value ? "secondary" : "ghost"}
          aria-pressed={aprPeriod === value}
          aria-label={
            value === "all" ? t`Since opening` : value === "7d" ? t`Last 7 days` : t`Last 30 days`
          }
          onClick={() => setAprPeriod(value)}
          className="h-7 px-2 text-xs"
        >
          {value === "all" ? t`All` : value}
        </Button>
      ))}
    </fieldset>
  );
  const earningsControl = (
    <fieldset className="flex gap-1" aria-label={t`Earnings history period`}>
      {(["latest", "all"] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant={earningsPeriod === value ? "secondary" : "ghost"}
          aria-pressed={earningsPeriod === value}
          aria-label={value === "latest" ? t`Latest 6 months` : t`All earnings history`}
          onClick={() => setEarningsPeriod(value)}
          className="h-7 px-2 text-xs"
        >
          {value === "latest" ? t`6m` : t`All`}
        </Button>
      ))}
    </fieldset>
  );
  const fallback = loading ? t`Loading history…` : (error ?? t`History unavailable.`);
  return (
    <div className="grid min-w-0 gap-4 @3xl/farming:grid-cols-2">
      <Section title={t`APR history`} action={control}>
        <p className="mb-3 text-xs text-muted-foreground">
          {nativePoints?.length
            ? t`Saved quoted rates · dated observations`
            : t`Saved quoted rates · first and last observations per month`}
        </p>
        {history ? (
          <HistoryChart
            points={points}
            bars={false}
            label={t`Browse quoted rate history`}
            maximumGapMs={(nativePoints?.length ? 2 : 40) * 86_400_000}
            dayLabels={aprPeriod !== "all"}
          />
        ) : (
          <Empty>{fallback}</Empty>
        )}
        {history ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {history.trend.latestRateFreshness === "current"
              ? t`Current latest rate`
              : history.trend.latestRateFreshness === "stale"
                ? t`Latest rate is stale`
                : t`Rate freshness unknown`}
            {history.trend.state !== "available" ? ` · ${t`Partial history`}` : ""}
            {!history.trend.methodologyComparable ? ` · ${t`Rate methods differ`}` : ""}
          </p>
        ) : null}
      </Section>
      <Section title={t`Earnings history`} action={earningsControl}>
        <p className="mb-3 text-xs text-muted-foreground">
          <Trans>Earned per closed UTC calendar month · USD</Trans>
        </p>
        {history ? (
          <HistoryChart points={earnings} bars label={t`Browse monthly earnings`} />
        ) : (
          <Empty>{fallback}</Empty>
        )}
        {history ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            <Trans>Missing or partial months remain unavailable.</Trans>
          </p>
        ) : null}
      </Section>
    </div>
  );
}
