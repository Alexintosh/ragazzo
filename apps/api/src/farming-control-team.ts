import {
  FARMING_CONTROL_SAFE_TOOLS,
  FARMING_CONTROL_SPECIALISTS,
  farmingControlBotId,
  farmingControlGroupId,
  farmingControlInstructions,
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
    if (!prior) {
      await repos.createBot(actor, {
        id,
        spawnKey,
        name: specialist.name,
        description: specialist.description,
        instructions,
        notifyOnFinish: true,
        fleetManagement: false,
        disabledBuiltinTools: BUILTIN_TOOL_NAMES.filter(
          (name) => !FARMING_CONTROL_SAFE_TOOLS.has(name),
        ),
      });
    } else if (prior.instructions === farmingControlInstructions(specialist.role, actor.spaceId, "legacy")) {
      // Upgrade only an untouched generated profile. The predicate also preserves concurrent edits.
      await prisma.bot.updateMany({
        where: { id, spaceId: actor.spaceId, userId: actor.userId, spawnKey, archivedAt: null, instructions: prior.instructions },
        data: { instructions },
      });
    }
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
    bots.push({ id, role: specialist.role, name: prior?.name ?? specialist.name });
  }
  const group = await createGroupRepos(prisma).createGroup(actor, {
    id: farmingControlGroupId(actor.spaceId),
    name: "Farming Control",
    botIds: bots.map((bot) => bot.id),
  });
  return { groupId: group.id, coordinatorId: bots[0]!.id, bots };
}
