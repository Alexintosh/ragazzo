import {
  FARMING_CONTROL_SAFE_TOOLS,
  FARMING_CONTROL_SPECIALISTS,
  farmingControlBotId,
  farmingControlGroupId,
  farmingControlInstructions,
  farmingControlSafeToolsForRole,
  farmingControlSpawnKey,
  farmingControlWorkflow,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createGroupRepos, createRepos, IsolationError } from "@rakazo/db";

/** Call only after the configured FC service authorizes the live personal-space actor. */
export async function ensureFarmingControlTeam(prisma: PrismaClient, actor: Actor) {
  const repos = createRepos(prisma);
  const bots: Array<{ id: string; role: string; name: string }> = [];
  for (const specialist of FARMING_CONTROL_SPECIALISTS) {
    const id = farmingControlBotId(actor.spaceId, specialist.role);
    const spawnKey = farmingControlSpawnKey(specialist.role);
    const prior = await prisma.bot.findUnique({ where: { id } });
    if (
      prior &&
      (prior.userId !== actor.userId ||
        prior.spaceId !== actor.spaceId ||
        prior.spawnKey !== spawnKey ||
        prior.archivedAt)
    ) {
      throw new IsolationError(
        "The configured FC specialist is unavailable. Restore its existing profile before continuing.",
      );
    }
    const instructions = farmingControlInstructions(specialist.role, actor.spaceId);
    const disabledBuiltinTools = BUILTIN_TOOL_NAMES.filter(
      (name) => !farmingControlSafeToolsForRole(specialist.role).has(name),
    );
    const generatedInstructions = (["current", "legacy", "pre-risk"] as const).flatMap(
      (precision) =>
        (["current", "legacy"] as const).flatMap((team) =>
          (["current", "legacy"] as const).flatMap((consultation) =>
            (["current", "legacy"] as const).flatMap((names) =>
              (["current", "legacy"] as const).map((refresh) =>
                farmingControlInstructions(
                  specialist.role,
                  actor.spaceId,
                  precision,
                  team,
                  consultation,
                  names,
                  refresh,
                ),
              ),
            ),
          ),
        ),
    );
    if (!prior) {
      await repos.createBot(actor, {
        id,
        spawnKey,
        name: specialist.name,
        description: specialist.description,
        instructions,
        notifyOnFinish: true,
        fleetManagement: false,
        disabledBuiltinTools,
      });
    } else if (generatedInstructions.includes(prior.instructions)) {
      const legacyDisabled = BUILTIN_TOOL_NAMES.filter(
        (name) => !FARMING_CONTROL_SAFE_TOOLS.has(name),
      );
      const generatedToolPolicy =
        prior.disabledBuiltinTools.length === legacyDisabled.length &&
        legacyDisabled.every((name) => prior.disabledBuiltinTools.includes(name));
      // Upgrade only generated profiles and exact generated tool restrictions.
      // CAS preserves concurrent instruction and tool edits independently.
      if (prior.instructions !== instructions)
        await prisma.bot.updateMany({
          where: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            spawnKey,
            archivedAt: null,
            instructions: prior.instructions,
          },
          data: { instructions },
        });
      if (specialist.role === "coordinator" && generatedToolPolicy)
        await prisma.bot.updateMany({
          where: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            spawnKey,
            archivedAt: null,
            instructions,
            disabledBuiltinTools: { equals: prior.disabledBuiltinTools },
          },
          data: { disabledBuiltinTools },
        });
    }
    // Rename only the old generated default; preserve personalized profiles and concurrent edits.
    if (prior?.name === `FC ${specialist.name}`)
      await prisma.bot.updateMany({
        where: {
          id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          spawnKey,
          archivedAt: null,
          name: prior.name,
        },
        data: { name: specialist.name },
      });
    // Deterministic skill identity makes a failed or concurrent first session repeat-safe.
    // It is deployment-provided and is read-only through the ordinary skill API.
    const skillId = `${id}:skill`;
    const skillName = `farming-control-${specialist.role}`;
    const content = buildSkillMd({
      name: skillName,
      description: specialist.description,
      body: farmingControlWorkflow(specialist.role),
    });
    await prisma.agentSkill.upsert({
      where: { id: skillId },
      update: { content, description: specialist.description },
      create: {
        id: skillId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: skillName,
        description: specialist.description,
        source: "builtin",
        content,
      },
    });
    const profile = await prisma.bot.findUnique({ where: { id }, select: { name: true } });
    bots.push({ id, role: specialist.role, name: profile?.name ?? specialist.name });
  }
  const groupId = farmingControlGroupId(actor.spaceId);
  const groups = createGroupRepos(prisma);
  const existing = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    select: { userId: true, spaceId: true, archivedAt: true, members: { select: { botId: true } } },
  });
  const botIds = bots.map((bot) => bot.id);
  const legacyIds = botIds.filter(
    (id) => id !== farmingControlBotId(actor.spaceId, "opportunities"),
  );
  if (existing) {
    if (
      existing.userId !== actor.userId ||
      existing.spaceId !== actor.spaceId ||
      existing.archivedAt
    )
      throw new IsolationError("The configured FC group is unavailable.");
    const current = existing.members.map((member) => member.botId);
    if (current.length === legacyIds.length && current.every((id) => legacyIds.includes(id))) {
      // Only the exact generated five-member team can be upgraded. CAS preserves concurrent edits.
      try {
        await groups.updateGroup(actor, { groupId, botIds, expectedBotIds: legacyIds });
      } catch (error) {
        // A concurrent provisioning may have completed the same upgrade. The strict
        // createGroup reread below accepts only the exact current generated membership.
        if (!(error instanceof IsolationError)) throw error;
      }
    }
  }
  const group = await groups.createGroup(actor, {
    id: farmingControlGroupId(actor.spaceId),
    name: "Farming Control",
    botIds,
  });
  return { groupId: group.id, coordinatorId: bots[0]!.id, bots };
}
