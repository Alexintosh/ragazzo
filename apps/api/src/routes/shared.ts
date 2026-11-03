import {
  deploymentModelRole,
  findConnectedModelCredential,
  hasHostedModelCredits,
  hostCredentialSource,
  mcpStdioAvailable,
  resolveMemberMainModel,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, Me } from "@rakazo/contracts";
import { attachmentMaxBytes, attachmentMaxCount, canonicalPiProviderId } from "@rakazo/contracts";
import { getHostedCreditPolicy, hostedCreditStatus, organizationForMember } from "@rakazo/db";
import { isAdmin } from "../admins.js";
import type { RouterDeps } from "../router.js";

export { createAdapterContext as computerContext } from "@rakazo/adapter-kit";

function hostCredentials(active: boolean, provider: string) {
  return active
    ? { hostCredentialProvider: provider, hostCredentialSource: hostCredentialSource(provider) }
    : { hostCredentialProvider: null, hostCredentialSource: null };
}

export async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup, admin, hostedPolicy] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: {
        email: true,
        name: true,
        timezone: true,
        signupSurvey: { select: { userId: true } },
      },
    }),
    modelSetup(deps, actor),
    isAdmin(deps, actor.userId),
    getHostedCreditPolicy(deps.prisma),
  ]);
  return {
    ticketBoardEnabled: deps.env.ticketBoardEnabled === true,
    phoneCallsEnabled: deps.env.phoneCallsEnabled === true,
    navLinks: deps.env.navLinks ?? [],
    maxUploadSizeBytes: attachmentMaxBytes(deps.env),
    maxAttachmentsPerMessage: attachmentMaxCount(deps.env),
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: false,
    isAdmin: admin,
    needsModel: setup.needsModel,
    defaultProvider: canonicalPiProviderId(setup.model?.provider ?? deps.env.defaultProvider),
    defaultModel: setup.model?.modelId ?? deps.env.defaultModel,
    // Set only while the active default is the deployment's own, running on host credentials.
    ...hostCredentials(
      !setup.main &&
        !setup.settings?.defaultModelProvider &&
        Boolean(deps.env.deploymentModelHostCredentials),
      deps.env.defaultProvider,
    ),
    computerHost: computerHostFor(setup.settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer:
      Boolean(deps.env.desktopHostChoiceEnabled) && deps.env.sandboxProvider === "docker",
    sandboxProvider: deps.env.sandboxProvider,
    mcpStdioEnabled:
      admin &&
      mcpStdioAvailable({
        stdioEnabled: deps.env.mcpStdioEnabled,
        allowedCommands: deps.env.mcpStdioAllowedCommands,
      }),
    avatarStyle: "organic",
    timezone: user.timezone ?? null,
    billingEnabled: Boolean(deps.billing),
    hostedCreditsEnabled: hostedPolicy.enabled || hostedPolicy.activatedAt !== null,
    // Only billing deployments ask; self-hosted installs never see the survey.
    needsSignupSurvey: Boolean(deps.billing) && !user.signupSurvey,
    paymentWalletProvider: deps.paymentWallet
      ? { id: deps.paymentWallet.describe().id, name: deps.paymentWallet.displayName }
      : null,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

/** The main model chat runs: the member's while it can run, else the deployment's. */
export async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [member, settings, hostedPolicy] = await Promise.all([
    resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    getHostedCreditPolicy(deps.prisma),
  ]);
  const main =
    member &&
    (member.credential ||
      ((deps.billing?.modelCreditsEnabled || hostedPolicy.enabled) &&
        (await hasHostedModelCredits(deps.prisma, actor, member.provider))))
      ? member
      : null;
  const funding = deps.billing ? await deps.billing.status(actor) : null;
  const organization = hostedPolicy.enabled
    ? await organizationForMember(deps.prisma, actor)
    : null;
  const hosted = organization
    ? await hostedCreditStatus(deps.prisma, organization.organizationId)
    : null;
  const creditFunding =
    hostedPolicy.enabled && hosted
      ? hosted.enabled
        ? { funding: "credits" as const, access: BigInt(hosted.balanceMicros) > 0n }
        : (funding ?? { funding: "byok" as const, access: Boolean(main?.credential) })
      : funding;
  const hasDeployment =
    Boolean(deps.env.deploymentModelConfigured) &&
    (hostedPolicy.enabled || hostedPolicy.activatedAt !== null
      ? hosted?.enabled === true
      : !funding?.creditPurchasesEnabled || funding.funding === "credits");
  return {
    main,
    model:
      main ??
      deploymentModelRole("main", {
        settings,
        deployment: { provider: deps.env.defaultProvider, model: deps.env.defaultModel },
      }).primary,
    settings,
    funding: creditFunding,
    hasDeployment,
    needsModel: deps.env.agentRuntime !== "scripted" && !main && !hasDeployment,
  };
}

/** Whether every bot runs its own model on one of the member's connections, as a run selects it. */
export async function botsRunOwnModels(deps: RouterDeps, actor: Actor, botIds: string[]) {
  const bots = await deps.prisma.bot.findMany({
    where: { id: { in: botIds }, userId: actor.userId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const credentials = await Promise.all(
    bots.map(async (bot) => {
      const overrideCredential = bot.modelProvider
        ? await findConnectedModelCredential(
            deps.prisma,
            deps.secrets,
            actor,
            bot.modelProvider,
            bot.modelId,
          )
        : null;
      return selectConfiguredModel({ override: bot, overrideCredential, main: null, defaults: {} })
        .credential;
    }),
  );
  return credentials.every(Boolean);
}

export const THREAD_MESSAGE_PAGE_SIZE = 100;

/** Silence longer than this on a thread stream is indistinguishable from a dead socket. */
export const HEARTBEAT_MS = 20_000;

/** A thread stream re-checks its session at least this often while it delivers. */
export const SESSION_RECHECK_MS = 10_000;

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export function isRecordNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2025");
}
