import type { RoleplayCharacter, RoleplayContinuity } from "@rakazo/contracts";
import type { RoleplayMessage } from "./roleplay.js";
import { buildRoleplayPrompt } from "./roleplay.js";
import type { RoleplayTemporalContext } from "./roleplay-temporal.js";
import { roleplayLocalTime } from "./roleplay-temporal.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const ROLEPLAY_SPONTANEOUS_LIMITS = {
  gentle: {
    maxPerDay: 1,
    inactivityHours: 24,
    reciprocalInactivityHours: 18,
    attemptHours: 3,
    maxAttemptsPerDay: 4,
  },
  balanced: {
    maxPerDay: 2,
    inactivityHours: 12,
    reciprocalInactivityHours: 8,
    attemptHours: 2,
    maxAttemptsPerDay: 8,
  },
  frequent: {
    maxPerDay: 3,
    inactivityHours: 6,
    reciprocalInactivityHours: 4,
    attemptHours: 1,
    maxAttemptsPerDay: 12,
  },
} as const;

export interface RoleplaySpontaneousEligibilityInput {
  character: RoleplayCharacter;
  now: string;
  timezone: string | null;
  lastUserMessageAt: string | null;
  lastInteractionAt?: string | null;
  realUserMessageCount: number;
  /** Actual user replies after assistant messages, excluding seeded/imported/generated messages. */
  reciprocalUserReplyCount: number;
  unansweredSpontaneousCount: number;
  /** Include all successful spontaneous sends in the preceding rolling UTC 24 hours. */
  spontaneousSentAt: string[];
  /** Include all generation attempts, including skip/error, in the preceding rolling UTC 24 hours. */
  attemptedAt: string[];
  warmth?: number;
}
export type RoleplaySpontaneousEligibilityReason =
  | "eligible"
  | "disabled"
  | "not-chat"
  | "unknown-timezone"
  | "invalid-facts"
  | "not-started"
  | "unanswered"
  | "quiet-hours"
  | "inactive-too-briefly"
  | "daily-cap"
  | "attempt-cap"
  | "attempt-cooldown";

/** Shared scheduler/executor policy. The caller separately fences archived/disabled bots and stale work. */
export function evaluateRoleplaySpontaneousEligibility(
  input: RoleplaySpontaneousEligibilityInput,
): { eligible: boolean; reason: RoleplaySpontaneousEligibilityReason } {
  const result = (reason: RoleplaySpontaneousEligibilityReason) => ({
    eligible: reason === "eligible",
    reason,
  });
  const settings = input.character.spontaneous;
  if (!settings?.enabled) return result("disabled");
  if (input.character.conversationStyle !== "chat") return result("not-chat");
  if (!roleplayLocalTime(input.now, input.timezone)) return result("unknown-timezone");
  const now = Date.parse(input.now);
  const counts = [
    input.realUserMessageCount,
    input.reciprocalUserReplyCount,
    input.unansweredSpontaneousCount,
  ];
  const timestamps = [
    ...input.spontaneousSentAt,
    ...input.attemptedAt,
    ...(input.lastInteractionAt ? [input.lastInteractionAt] : []),
    ...(input.lastUserMessageAt ? [input.lastUserMessageAt] : []),
  ];
  if (
    (input.warmth !== undefined &&
      (!Number.isInteger(input.warmth) || input.warmth < 0 || input.warmth > 100)) ||
    !Number.isFinite(now) ||
    counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    timestamps.some((date) => !Number.isFinite(Date.parse(date)) || Date.parse(date) > now)
  )
    return result("invalid-facts");
  if (!input.realUserMessageCount || !input.lastUserMessageAt) return result("not-started");
  if (input.unansweredSpontaneousCount > 0) return result("unanswered");
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      timeZone: input.timezone!,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(now)),
  );
  if (
    (hour < 9 && !(settings.allowLateNight && hour < 1)) ||
    (!settings.allowLateNight && hour >= 21)
  )
    return result("quiet-hours");
  const limits = ROLEPLAY_SPONTANEOUS_LIMITS[settings.frequency];
  const recent = (dates: string[]) =>
    dates.map((date) => Date.parse(date)).filter((date) => date > now - DAY && date <= now);
  const sends = recent(input.spontaneousSentAt);
  const attempts = recent(input.attemptedAt);
  if (sends.length >= limits.maxPerDay) return result("daily-cap");
  if (attempts.length >= limits.maxAttemptsPerDay) return result("attempt-cap");
  if (attempts.some((date) => now - date < limits.attemptHours * HOUR))
    return result("attempt-cooldown");
  const reciprocal = (input.warmth ?? 10) >= 40 && input.reciprocalUserReplyCount >= 4;
  const inactivityHours = reciprocal ? limits.reciprocalInactivityHours : limits.inactivityHours;
  const lastInteraction = Math.max(
    Date.parse(input.lastUserMessageAt),
    input.lastInteractionAt ? Date.parse(input.lastInteractionAt) : -Infinity,
    ...sends,
  );
  if (now - lastInteraction < inactivityHours * HOUR) return result("inactive-too-briefly");
  return result("eligible");
}

export type RoleplaySpontaneousDecision =
  | { decision: "skip" }
  | { decision: "send"; messages: string[] };

/** Only a complete, bounded structured response can authorize a send. No repair of model prose. */
export function parseRoleplaySpontaneousDecision(text: string): RoleplaySpontaneousDecision | null {
  if (new TextEncoder().encode(text).length > 8_192) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.decision === "skip" && Object.keys(data).length === 1) return { decision: "skip" };
    if (
      data.decision !== "send" ||
      Object.keys(data).length !== 2 ||
      !Array.isArray(data.messages) ||
      data.messages.length < 1 ||
      data.messages.length > 3 ||
      !data.messages.every(
        (message) =>
          typeof message === "string" && message.trim().length > 0 && message.length <= 2_000,
      )
    )
      return null;
    return { decision: "send", messages: data.messages.map((message: string) => message.trim()) };
  } catch {
    return null;
  }
}

export function buildRoleplaySpontaneousRequest(input: {
  character: RoleplayCharacter;
  history: RoleplayMessage[];
  temporal: RoleplayTemporalContext;
  summary?: string;
  continuity?: RoleplayContinuity;
  playerName?: string;
  loreTokenLimit?: number;
}): ReturnType<typeof buildRoleplayPrompt> {
  const request = buildRoleplayPrompt({ ...input, prompt: "" });
  return {
    ...request,
    instructions: [
      request.instructions,
      "This is an optional spontaneous chat check-in, not a reply to a new user message. You have no tools or media capabilities. Choose skip unless there is a grounded reason to contact the user in this character's voice. Use established conversation details or a tentative follow-up on a real plan; never assume an elapsed event happened. Do not fabricate activities, photos, attachments, links, messages from others, or external facts. Avoid guilt, pressure, possessiveness, or repeated unanswered nudges. Warmth follows demonstrated reciprocal conversation, never an assumed relationship upgrade.",
      'Return exactly {"decision":"skip"} or {"decision":"send","messages":["one short plain-text bubble"]}. A send has one to three nonempty bubbles, each at most 2000 characters. No markdown fences, extra fields, tool calls, or media.',
    ].join("\n\n"),
    prompt: JSON.stringify({
      purpose: "Decide whether a spontaneous message is warranted now; skipping is welcome.",
    }),
  };
}
