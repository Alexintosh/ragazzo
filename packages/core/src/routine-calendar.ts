import type { Routine, RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { isOneShotRoutineCrons, nextCronDateAcrossStrict } from "./cron.js";

export type CalendarView = "day" | "week" | "month";
export type CalendarEntry = { id: string; routine: Routine; at: string; run: RoutineRun | null };

/** Calendar boundaries follow the viewer's local date; cron evaluation follows each routine's timezone. */
export function calendarRange(date: Date, view: CalendarView) {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (view === "week") from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  if (view === "month") from.setDate(1);
  const to = new Date(from);
  if (view === "month") to.setMonth(to.getMonth() + 1);
  else to.setDate(to.getDate() + (view === "week" ? 7 : 1));
  return { from, to };
}

export function shiftCalendar(date: Date, view: CalendarView, direction: number) {
  const next = new Date(date);
  if (view === "month") {
    next.setDate(1);
    next.setMonth(next.getMonth() + direction);
  } else next.setDate(next.getDate() + direction * (view === "week" ? 7 : 1));
  return next;
}

export async function calendarHistory(
  routineId: string,
  from: Date,
  to: Date,
  read: (input: { routineId: string; before?: RoutineRunCursor }) => Promise<RoutineHistory>,
  signal?: AbortSignal,
): Promise<RoutineRun[]> {
  const runs: RoutineRun[] = [];
  let before: RoutineRunCursor | undefined;
  do {
    signal?.throwIfAborted();
    const page = await read({ routineId, before });
    signal?.throwIfAborted();
    runs.push(
      ...page.runs.filter((run) => {
        const at = Date.parse(run.createdAt);
        return at >= from.getTime() && at < to.getTime();
      }),
    );
    // History and cursors are ordered by creation time, including runs that remain queued.
    if (!page.nextCursor || Date.parse(page.nextCursor.createdAt) < from.getTime()) break;
    before = page.nextCursor;
  } while (before);
  return runs;
}

export function calendarEntries(
  routine: Routine,
  runs: RoutineRun[],
  range: { from: Date; to: Date },
  now: Date,
) {
  const entries: CalendarEntry[] = runs.map((run) => ({
    id: run.id,
    routine,
    at: run.createdAt,
    run,
  }));
  // Watches and external triggers do not promise an execution at their next check.
  if (!routine.active || routine.watch || !routine.crons.length)
    return { entries, truncated: false };
  if (isOneShotRoutineCrons(routine.crons)) {
    const at = routine.nextRunAt;
    if (
      at &&
      Date.parse(at) >= Math.max(now.getTime(), range.from.getTime()) &&
      Date.parse(at) < range.to.getTime()
    ) {
      entries.push({ id: `${routine.id}:${at}`, routine, at, run: null });
    }
    return { entries, truncated: false };
  }
  let cursor = new Date(Math.max(now.getTime(), range.from.getTime() - 1));
  for (let count = 0; count <= 1000; count++) {
    const next = nextCronDateAcrossStrict(routine.crons, cursor, routine.timezone);
    if (!next || next >= range.to) return { entries, truncated: false };
    if (count === 1000) return { entries, truncated: true };
    const at = next.toISOString();
    entries.push({ id: `${routine.id}:${at}`, routine, at, run: null });
    cursor = next;
  }
  return { entries, truncated: false };
}
