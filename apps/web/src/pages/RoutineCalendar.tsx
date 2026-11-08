import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption, Spinner } from "@rakazo/ui-web";
import { useQueries } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { statusLabel, statusTone } from "./ActivityList";
import type { CalendarView } from "./routine-calendar";
import { calendarEntries, calendarHistory, calendarRange, shiftCalendar } from "./routine-calendar";

export function RoutineCalendar({
  routines,
  onEdit,
}: {
  routines: Routine[];
  onEdit: (routine: Routine) => void;
}) {
  const { i18n, t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const [date, setDate] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const { from, to } = calendarRange(date, view);
  const histories = useQueries({
    queries: routines.map((routine) => ({
      queryKey: [
        ...queries.routines.history.queryKey({ input: { routineId: routine.id } }),
        "calendar",
        from.toISOString(),
        to.toISOString(),
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        calendarHistory(routine.id, from, to, rpc.routines.history, signal),
      refetchInterval: 15_000,
    })),
  });
  const now = new Date();
  const results = routines.map((routine, index) =>
    calendarEntries(routine, histories[index]?.data ?? [], { from, to }, now),
  );
  const entries = results
    .flatMap((result) => result.entries)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const days: Date[] = [];
  for (let day = new Date(from); day < to; day.setDate(day.getDate() + 1)) days.push(new Date(day));
  const locale = i18n.locale || "en";
  return (
    <section
      aria-label={t`Routine calendar`}
      data-testid="routine-calendar"
      className="mt-3 space-y-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t`Previous period`}
          onClick={() => setDate(shiftCalendar(date, view, -1))}
        >
          <ChevronLeft size={14} />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setDate(new Date())}>
          <Trans>Today</Trans>
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t`Next period`}
          onClick={() => setDate(shiftCalendar(date, view, 1))}
        >
          <ChevronRight size={14} />
        </Button>
        <NativeSelect
          aria-label={t`Calendar view`}
          value={view}
          onChange={(event) => setView(event.target.value as CalendarView)}
          className="ml-auto w-auto"
        >
          <NativeSelectOption value="day">{t`Day`}</NativeSelectOption>
          <NativeSelectOption value="week">{t`Week`}</NativeSelectOption>
          <NativeSelectOption value="month">{t`Month`}</NativeSelectOption>
        </NativeSelect>
      </div>
      <p className="text-xs text-muted-foreground">
        {from.toLocaleDateString(locale, { month: "long", year: "numeric" })} ·{" "}
        {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </p>
      {histories.some((query) => query.isPending) ? <Spinner aria-label={t`Loading…`} /> : null}
      {histories.some((query) => query.isError) ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not load run history</Trans>{" "}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              for (const query of histories) void query.refetch();
            }}
          >
            <Trans>Retry</Trans>
          </Button>
        </p>
      ) : null}
      {results.some((result) => result.truncated) ? (
        <p role="status" className="text-muted-foreground">
          <Trans>More occurrences. Choose a shorter period.</Trans>
        </p>
      ) : null}
      <div className="divide-y divide-border">
        {days.map((day) => {
          const dayEntries = entries.filter(
            (entry) => new Date(entry.at).toDateString() === day.toDateString(),
          );
          return (
            <div key={day.toISOString()} className="py-2">
              <h4 className="mb-1 text-xs text-muted-foreground">
                {day.toLocaleDateString(locale, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </h4>
              {dayEntries.length ? (
                <ul className="space-y-2">
                  {dayEntries.map((entry) => {
                    const run = entry.run;
                    const chat = run?.messageId
                      ? `${run.groupId ? `/app/g/${encodeURIComponent(run.groupId)}` : `/app/${encodeURIComponent(run.botId)}`}?m=${encodeURIComponent(run.messageId)}`
                      : null;
                    return (
                      <li key={entry.id} className="space-y-1" data-testid="routine-calendar-entry">
                        <div className="flex items-center gap-2">
                          <time dateTime={entry.at} className="text-xs tabular-nums">
                            {new Date(entry.at).toLocaleTimeString(locale, {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                          <Button
                            variant="text"
                            className="min-w-0 truncate"
                            onClick={() => onEdit(entry.routine)}
                          >
                            {entry.routine.name}
                          </Button>
                          <span
                            className={`ml-auto text-xs ${run ? statusTone(run.status) : "text-muted-foreground"}`}
                          >
                            {run ? statusLabel(run.status) : t`Scheduled`}
                          </span>
                        </div>
                        {chat ? (
                          <Link className="text-xs underline underline-offset-2" to={chat}>
                            <Trans>View chat</Trans>
                          </Link>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">—</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
