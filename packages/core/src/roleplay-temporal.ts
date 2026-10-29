import type { RoleplayCharacter } from "@rakazo/contracts";

export interface RoleplayTemporalContext {
  now: string;
  timezone?: string | null;
  lastInteractionAt?: string | null;
}

/** Unknown zones stay unknown; a server's local zone is never a user's zone. */
export function roleplayLocalTime(now: string, timezone?: string | null): string | null {
  if (!timezone || !Number.isFinite(Date.parse(now))) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(now));
  } catch {
    return null;
  }
}

export function buildRoleplayTemporalContext(
  context: RoleplayTemporalContext,
  style?: RoleplayCharacter["conversationStyle"],
): string {
  const validNow = Number.isFinite(Date.parse(context.now));
  const localTime = roleplayLocalTime(context.now, context.timezone);
  const previous = context.lastInteractionAt ? Date.parse(context.lastInteractionAt) : NaN;
  const elapsed =
    validNow && Number.isFinite(previous) ? Math.max(0, Date.parse(context.now) - previous) : null;
  return [
    "Time context (application metadata, not fictional events):",
    JSON.stringify({
      now: validNow ? context.now : null,
      timezone: localTime ? context.timezone : null,
      localTime,
      lastInteractionAt: Number.isFinite(previous) ? context.lastInteractionAt : null,
      elapsedMilliseconds: elapsed,
    }),
    "Keep metadata internal; never echo its labels or timestamp wrappers. This runtime cannot set timers or schedule messages in requested minutes; spontaneous check-ins follow application policy. Never claim a reminder is set or promise exact-time contact. Explain the limitation naturally when asked; suggest a user-set reminder.",
    "Resolve relative dates from the original message createdAt in the known user timezone; leave dates uncertain if either is missing. Newer corrections and cancellations replace older plans. Passing dates do not confirm events: ask or leave unresolved without user confirmation. Never invent intervening activity or demand explanations for absence.",
    style === "chat"
      ? "Real elapsed time may inform a natural chat greeting or a relevant, tentative check-in. Keep any gap acknowledgment proportionate and optional."
      : "Wall-clock time and fiction time are separate. Resume the established fictional scene without automatically advancing its clock, characters, or events because real time elapsed.",
  ].join("\n\n");
}
