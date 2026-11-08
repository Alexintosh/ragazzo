import type { Routine, RoutineRun } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { calendarEntries, calendarHistory, calendarRange, shiftCalendar } from "./routine-calendar";

const routine = {
  id: "routine-1",
  name: "Morning",
  active: true,
  crons: ["0 9 * * *"],
  timezone: "America/New_York",
  watch: null,
} as Routine;
const run = (at: string): RoutineRun => ({
  id: at,
  botId: "bot-1",
  groupId: null,
  status: "completed",
  error: null,
  createdAt: at,
  startedAt: at,
  completedAt: at,
  messageId: null,
});
it("uses Monday weeks and exclusive local day/month boundaries", () => {
  const date = new Date(2026, 9, 31, 16);
  expect(calendarRange(date, "week")).toEqual({
    from: new Date(2026, 9, 26),
    to: new Date(2026, 10, 2),
  });
  expect(calendarRange(date, "month")).toEqual({
    from: new Date(2026, 9, 1),
    to: new Date(2026, 10, 1),
  });
  expect(calendarRange(date, "day")).toEqual({
    from: new Date(2026, 9, 31),
    to: new Date(2026, 10, 1),
  });
});
it("moves from the last day into the adjacent month without skipping it", () => {
  expect(shiftCalendar(new Date(2026, 0, 31), "month", 1)).toEqual(new Date(2026, 1, 1));
  expect(shiftCalendar(new Date(2026, 0, 1), "week", -1)).toEqual(new Date(2025, 11, 25));
});
it("previews the scheduler timezone across DST and keeps actual run states", () => {
  const range = { from: new Date("2026-10-31T00:00:00Z"), to: new Date("2026-11-03T00:00:00Z") };
  const actual = run("2026-10-31T13:00:00Z");
  actual.status = "failed";
  const result = calendarEntries(routine, [actual], range, new Date("2026-11-01T00:00:00Z"));
  expect(result.entries.map((entry) => entry.at)).toEqual([
    "2026-10-31T13:00:00Z",
    "2026-11-01T14:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
  ]);
  expect(result.entries[0]?.run?.status).toBe("failed");
  expect(result.entries[1]?.run).toBeNull();
});
it("does not promise executions for paused or change-triggered routines", () => {
  const range = { from: new Date("2026-10-31T00:00:00Z"), to: new Date("2026-11-03T00:00:00Z") };
  expect(calendarEntries({ ...routine, active: false }, [], range, range.from).entries).toEqual([]);
  expect(
    calendarEntries(
      { ...routine, watch: { kind: "files", paths: ["inbox"], everyMinutes: 5, loud: false } },
      [],
      range,
      range.from,
    ).entries,
  ).toEqual([]);
});
it("caps dense schedules with an explicit truncation flag", () => {
  const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
  const result = calendarEntries(
    { ...routine, crons: ["* * * * *"], timezone: "UTC" },
    [],
    range,
    range.from,
  );
  expect(result.entries).toHaveLength(1000);
  expect(result.truncated).toBe(true);
});
it("loads older cursor pages and respects exclusive range boundaries", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      runs: [run("2026-10-04T00:00:00Z")],
      nextCursor: { id: "cursor-1", createdAt: "2026-10-03T00:00:00Z" },
    })
    .mockResolvedValueOnce({
      runs: [run("2026-10-03T00:00:00Z"), run("2026-10-02T00:00:00Z"), run("2026-10-01T00:00:00Z")],
      nextCursor: { id: "cursor-2", createdAt: "2026-10-01T00:00:00Z" },
    });
  const result = await calendarHistory(
    "routine-1",
    new Date("2026-10-02T00:00:00Z"),
    new Date("2026-10-03T00:00:00Z"),
    read,
  );
  expect(result.map((entry) => entry.createdAt)).toEqual(["2026-10-02T00:00:00Z"]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0].before.id).toBe("cursor-1");
});

it("uses the stored one-shot time exactly once and omits an unarmed one-shot", () => {
  const range = { from: new Date("2026-10-31T00:00:00Z"), to: new Date("2026-11-03T00:00:00Z") };
  const once = { ...routine, crons: ["@once"], nextRunAt: "2026-11-01T14:00:00Z" };
  expect(calendarEntries(once, [], range, range.from).entries.map((entry) => entry.at)).toEqual([
    once.nextRunAt,
  ]);
  expect(calendarEntries({ ...once, nextRunAt: null }, [], range, range.from).entries).toEqual([]);
});

it("stops a cancelled history request before fetching another page", async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => {
    controller.abort();
    return { runs: [], nextCursor: { id: "cursor-1", createdAt: "2026-11-01T00:00:00Z" } };
  });
  await expect(
    calendarHistory(
      "routine-1",
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-11-02T00:00:00Z"),
      read,
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});
