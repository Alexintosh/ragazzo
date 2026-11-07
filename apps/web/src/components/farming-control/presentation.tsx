import { Trans, useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardHeader, CardTitle } from "@rakazo/ui-web";
import type { PointerEvent, ReactNode } from "react";
import { useState } from "react";

/** Scale exact source decimal strings, including exponent notation, without floating-point totals. */
function scaledInteger(value: string, places: number, rounded = false): bigint | null {
  const match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const [whole = "0", fraction = ""] = match[2]!.split(".");
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return null;
  const digits = (whole + fraction).replace(/^0+/, "") || "0";
  const shift = places + exponent - fraction.length;
  let result: bigint;
  if (shift >= 0) result = BigInt(digits) * 10n ** BigInt(shift);
  else {
    const keep = digits.length + shift;
    result = BigInt(keep > 0 ? digits.slice(0, keep) : "0");
    if (rounded && keep >= 0 && Number(digits[keep] ?? "0") >= 5) result += 1n;
  }
  return match[1] === "-" ? -result : result;
}

export function exactAmount(value: string | null | undefined, currency = "USD"): string {
  if (value == null) return "—";
  const scaled = scaledInteger(value, 2, true);
  if (scaled === null) return "—";
  const cents = scaled < 0n ? -scaled : scaled;
  const digits = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = (cents % 100n).toString().padStart(2, "0");
  const prefix = currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  return `${scaled < 0n ? "−" : ""}${prefix}${digits}.${decimals}`;
}

export function exactPercent(value: string | null | undefined): string {
  if (value == null) return "—";
  const scaled = scaledInteger(value, 2, true);
  if (scaled === null) return "—";
  const abs = scaled < 0n ? -scaled : scaled;
  return `${scaled < 0n ? "−" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

/** Compare source decimals without rounding; unavailable values stay last in either direction. */
export function compareExactAmounts(
  left: string | null | undefined,
  right: string | null | undefined,
  direction: "ascending" | "descending" = "descending",
): number {
  const parse = (value: string | null | undefined) => {
    if (value == null) return null;
    const match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match) return null;
    const [whole = "0", fraction = ""] = match[2]!.split(".");
    const digits = (whole + fraction).replace(/^0+/, "");
    const exponent = BigInt(match[3] ?? "0") - BigInt(fraction.length);
    return { digits, exponent, sign: !digits ? 0 : match[1] === "-" ? -1 : 1 };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  let comparison = a.sign - b.sign;
  if (comparison === 0 && a.sign !== 0) {
    const aOrder = BigInt(a.digits.length) + a.exponent;
    const bOrder = BigInt(b.digits.length) + b.exponent;
    if (aOrder !== bOrder) comparison = aOrder > bOrder ? 1 : -1;
    else {
      const width = Math.max(a.digits.length, b.digits.length);
      const aDigits = a.digits.padEnd(width, "0");
      const bDigits = b.digits.padEnd(width, "0");
      comparison = aDigits === bDigits ? 0 : aDigits > bDigits ? 1 : -1;
    }
    comparison *= a.sign;
  }
  return direction === "ascending" ? comparison : -comparison;
}

function chartMagnitude(value: string): bigint {
  return scaledInteger(value, 6) ?? 0n;
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1.5 break-words text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
      </CardContent>
    </Card>
  );
}

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Distribution({
  rows,
  empty,
  limit,
}: {
  limit?: number;
  rows: { id: string; label: string; value: string; onSelect?: () => void }[];
  empty: ReactNode;
}) {
  const ranked = rows
    .map((row) => ({ row, magnitude: chartMagnitude(row.value) }))
    .filter(({ magnitude }) => magnitude > 0n)
    .sort((a, b) => compareExactAmounts(a.row.value, b.row.value));
  const total = ranked.reduce((sum, entry) => sum + entry.magnitude, 0n);
  if (total === 0n) return <Empty>{empty}</Empty>;
  return (
    <div className="space-y-4">
      {ranked.slice(0, limit ?? ranked.length).map(({ row, magnitude }) => {
        const width = Number((magnitude * 10_000n) / total) / 100;
        const content = (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm">{row.label}</span>
              <span className="shrink-0 text-sm tabular-nums">{exactAmount(row.value)}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${width}%` }}
              />
            </div>
          </>
        );
        return row.onSelect ? (
          <button
            key={row.id}
            type="button"
            onClick={row.onSelect}
            className="block w-full rounded-md text-start outline-none hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </button>
        ) : (
          <div key={row.id}>{content}</div>
        );
      })}
    </div>
  );
}

export function ValueHistory({
  points,
  gaps = [],
}: {
  points: { snapshotId: string; at: string; value: string | null }[];
  gaps?: { fromMs: number; toMs: number }[];
}) {
  const { t } = useLingui();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ordered = points
    .filter((point) => Number.isFinite(Date.parse(point.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const known = ordered.filter(
    (point): point is { snapshotId: string; at: string; value: string } =>
      point.value !== null && scaledInteger(point.value, 6) !== null,
  );
  const matchingIndex = known.findIndex((point) => point.snapshotId === selectedId);
  if (selectedId !== null && matchingIndex < 0) setSelectedId(null);
  if (known.length < 2)
    return (
      <Empty>
        <Trans>Not enough history to chart.</Trans>
      </Empty>
    );
  const values = known.map((point) => chartMagnitude(point.value));
  const minimum = values.reduce((a, b) => (a < b ? a : b));
  const maximum = values.reduce((a, b) => (a > b ? a : b));
  const range = maximum - minimum || 1n;
  const start = Date.parse(known[0]!.at);
  const duration = Date.parse(known.at(-1)!.at) - start || 1;
  const xCoordinate = (at: string) => 16 + ((Date.parse(at) - start) / duration) * 968;
  const coordinate = (point: { at: string; value: string }) => ({
    x: xCoordinate(point.at),
    y: 180 - Number(((chartMagnitude(point.value) - minimum) * 150_000n) / range) / 1000,
  });
  const coordinates = known.map(coordinate);
  const segments: { snapshotId: string; at: string; value: string }[][] = [];
  let previousAt: number | null = null;
  for (const point of ordered) {
    const at = Date.parse(point.at);
    if (point.value === null || scaledInteger(point.value, 6) === null) {
      previousAt = null;
      continue;
    }
    const interrupted =
      previousAt === null ||
      at - previousAt > 2 * 86_400_000 ||
      gaps.some((gap) => gap.fromMs < at && gap.toMs > previousAt!);
    if (interrupted) segments.push([]);
    segments.at(-1)!.push({ snapshotId: point.snapshotId, at: point.at, value: point.value });
    previousAt = at;
  }
  const label = t`Portfolio value history`;
  const selectedIndex = matchingIndex < 0 ? known.length - 1 : matchingIndex;
  const selected = known[selectedIndex]!;
  const selectedCoordinate = coordinates[selectedIndex]!;
  const selectedDate = new Date(selected.at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const cursor = svg.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const { x, y } = cursor.matrixTransform(matrix.inverse());
    let nearestIndex = 0;
    for (let index = 1; index < coordinates.length; index++) {
      const point = coordinates[index]!;
      const nearest = coordinates[nearestIndex]!;
      const distance = Math.abs(point.x - x);
      const nearestDistance = Math.abs(nearest.x - x);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance && Math.abs(point.y - y) < Math.abs(nearest.y - y))
      ) {
        nearestIndex = index;
      }
    }
    const inAvailableSpan = segments.some(
      (segment) => x >= xCoordinate(segment[0]!.at) && x <= xCoordinate(segment.at(-1)!.at),
    );
    if (!inAvailableSpan && Math.abs(coordinates[nearestIndex]!.x - x) > 6) {
      setSelectedId(null);
      return;
    }
    setSelectedId(known[nearestIndex]!.snapshotId);
  };
  const date = (at: string) =>
    new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <figure className="m-0">
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <time dateTime={selected.at}>{selectedDate}</time>
        <span>{exactAmount(selected.value)}</span>
      </div>
      <div className="relative rounded-sm focus-within:ring-2 focus-within:ring-ring">
        <input
          type="range"
          min={0}
          max={known.length - 1}
          step={1}
          value={selectedIndex}
          aria-label={label}
          aria-valuetext={`${selectedDate}: ${exactAmount(selected.value)}`}
          className="sr-only"
          onFocus={() => setSelectedId(selected.snapshotId)}
          onChange={(event) => setSelectedId(known[Number(event.currentTarget.value)]!.snapshotId)}
        />
        <svg
          viewBox="0 0 1000 210"
          className="h-48 w-full touch-pan-y overflow-visible text-foreground"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (!event.isPrimary) return;
            if (event.pointerType !== "mouse")
              event.currentTarget.setPointerCapture(event.pointerId);
            selectPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.isPrimary && (event.pointerType === "mouse" || event.buttons > 0)) {
              selectPointer(event);
            }
          }}
          onPointerLeave={(event) => {
            if (
              event.pointerType === "mouse" &&
              !event.currentTarget.parentElement?.contains(document.activeElement)
            ) {
              setSelectedId(null);
            }
          }}
        >
          <line x1="16" y1="180" x2="984" y2="180" className="stroke-border" />
          <line
            x1="16"
            y1="105"
            x2="984"
            y2="105"
            className="stroke-border"
            strokeDasharray="3 7"
          />
          <line x1="16" y1="30" x2="984" y2="30" className="stroke-border" strokeDasharray="3 7" />
          {segments
            .filter((segment) => segment.length > 1)
            .map((segment) => (
              <polyline
                key={segment[0]!.snapshotId}
                points={segment
                  .map((point) => {
                    const { x, y } = coordinate(point);
                    return `${x},${y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            ))}
          {known.map((point, index) => {
            const { x, y } = coordinates[index]!;
            return <circle key={point.snapshotId} cx={x} cy={y} r="2.5" fill="currentColor" />;
          })}
          {matchingIndex >= 0 ? (
            <g className="pointer-events-none">
              <line
                x1={selectedCoordinate.x}
                y1="24"
                x2={selectedCoordinate.x}
                y2="186"
                className="stroke-foreground/40"
                strokeDasharray="3 5"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={selectedCoordinate.x}
                cy={selectedCoordinate.y}
                r="5"
                className="fill-background stroke-foreground"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
        </svg>
      </div>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{date(known[0]!.at)}</span>
        <span>{date(known.at(-1)!.at)}</span>
      </figcaption>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          <Trans>View observations</Trans>
        </summary>
        <div className="mt-2 max-h-40 overflow-y-auto">
          {known.map((point) => (
            <div key={point.snapshotId} className="flex justify-between gap-3 py-1 tabular-nums">
              <time dateTime={point.at}>{new Date(point.at).toLocaleString()}</time>
              <span>{exactAmount(point.value)}</span>
            </div>
          ))}
        </div>
      </details>
    </figure>
  );
}
