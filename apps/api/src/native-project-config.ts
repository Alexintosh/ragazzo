import { ORPCError } from "@orpc/server";
import type { Actor, SetBotExecutionInput } from "@rakazo/contracts";
import { validateBotExecution } from "@rakazo/db";
import { assertNativeSetupAdmission } from "./native-setup-admission.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** Pin the selected host's canonical path before saving any native execution configuration. */
export async function resolveNativeProjectConfig(
  deps: RouterDeps,
  actor: Actor,
  input: SetBotExecutionInput,
  signal?: AbortSignal,
): Promise<SetBotExecutionInput> {
  validateBotExecution(input);
  if (input.runtimeKind === "pi") return input;
  try {
    if (!deps.hostProjectDirectory) throw new Error("Host project resolution unavailable");
    await deps.prisma.$transaction((tx) => assertNativeSetupAdmission(tx, actor));
    const projectPath = await deps.hostProjectDirectory(
      { hostId: input.registeredHostId ?? null, path: input.projectPath! },
      {
        ...computerContext(actor, input.botId, "execution.project"),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    return { ...input, projectPath };
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Could not open the project folder. Choose an existing folder on the selected host and check local consent.",
    });
  }
}
