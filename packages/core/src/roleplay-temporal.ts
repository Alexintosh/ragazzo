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
    "Resolve relative dates such as tomorrow against the original message's createdAt timestamp in the known user timezone, never against today's date. When a timestamp or timezone is missing, leave the date uncertain. Newer explicit corrections and cancellations supersede older plans. A date passing does not establish that an event happened; ask or leave it unresolved unless the user confirmed its outcome. Do not invent intervening activity or demand an explanation for absence.",
    style === "chat"
      ? "Real elapsed time may inform a natural chat greeting or a relevant, tentative check-in. Keep any gap acknowledgment proportionate and optional."
      : "Wall-clock time and fiction time are separate. Resume the established fictional scene without automatically advancing its clock, characters, or events because real time elapsed.",
  ].join("\n\n");
}
