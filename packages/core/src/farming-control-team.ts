/** Stable identities for deployment-provisioned private FC specialists. */
export const FARMING_CONTROL_ROLES = [
  "coordinator",
  "accounting",
  "tax",
  "risk",
  "operations",
] as const;
export type FarmingControlRole = (typeof FARMING_CONTROL_ROLES)[number];
export function farmingControlBotId(spaceId: string, role: FarmingControlRole): string {
  return `fc-specialist:${spaceId}:${role}`;
}
export function farmingControlSpawnKey(role: FarmingControlRole): string {
  return `farming-control:v1:${role}`;
}
export function farmingControlGroupId(spaceId: string): string {
  return `fc-team:${spaceId}`;
}
type BotIdentity = { id: string; spaceId: string; spawnKey?: string | null };
export function farmingControlRole(bot: BotIdentity): FarmingControlRole | undefined {
  return FARMING_CONTROL_ROLES.find(
    (role) =>
      bot.id === farmingControlBotId(bot.spaceId, role) &&
      bot.spawnKey === farmingControlSpawnKey(role),
  );
}
/** Reserved IDs stay private even after a profile edit or bridge removal. */
export function isFarmingControlSpecialist(bot: BotIdentity): boolean {
  return (
    FARMING_CONTROL_ROLES.some((role) => bot.id === farmingControlBotId(bot.spaceId, role)) ||
    Boolean(bot.spawnKey?.startsWith("farming-control:"))
  );
}
/** Legacy origin tags must not convert external/bot messages into owner app input. */
export function farmingControlOutsideBlocks(blocks: unknown): boolean {
  return (
    !Array.isArray(blocks) ||
    blocks.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "kind" in block &&
        (block.kind === "channel_message" || block.kind === "bot_message_received"),
    )
  );
}
