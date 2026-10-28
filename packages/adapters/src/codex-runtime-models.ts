import type { RuntimeModels, ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { CodexClient } from "./codex-app-server.js";

function effort(value: unknown): ThinkingLevel | null {
  const parsed = ThinkingLevelSchema.safeParse(value === "none" ? "off" : value);
  return parsed.success ? parsed.data : null;
}

/** Read the installed app-server's protocol catalog; never starts a provider turn. */
export async function codexRuntimeModels(client: CodexClient): Promise<RuntimeModels> {
  const models: RuntimeModels["models"] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.request("model/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) throw new Error("Native model catalog is unavailable");
    for (const row of result.data) {
      if (row.hidden === true) continue;
      if (
        typeof row.model !== "string" ||
        !row.model ||
        row.model.length > 200 ||
        typeof row.displayName !== "string" ||
        !row.displayName ||
        row.displayName.length > 256 ||
        !Array.isArray(row.supportedReasoningEfforts)
      )
        throw new Error("Native model catalog is invalid");
      if (seen.has(row.model)) continue;
      seen.add(row.model);
      const thinkingLevels = row.supportedReasoningEfforts
        .map((entry: { reasoningEffort?: unknown }) => effort(entry?.reasoningEffort))
        .filter((value: ThinkingLevel | null): value is ThinkingLevel => value !== null);
      const defaultThinkingLevel = effort(row.defaultReasoningEffort);
      models.push({
        id: row.model,
        name: row.displayName,
        thinkingLevels: [...new Set<ThinkingLevel>(thinkingLevels)],
        defaultThinkingLevel:
          defaultThinkingLevel && thinkingLevels.includes(defaultThinkingLevel)
            ? defaultThinkingLevel
            : null,
        isDefault: row.isDefault === true,
      });
      if (models.length > 1000) throw new Error("Native model catalog is too large");
    }
    if (result.nextCursor == null)
      return {
        runtimeKind: "codex",
        available: true,
        models,
        defaultModelId: models.find((model) => model.isDefault)?.id ?? null,
      };
    if (
      typeof result.nextCursor !== "string" ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    )
      throw new Error("Native model catalog pagination is invalid");
    cursor = result.nextCursor;
    cursors.add(result.nextCursor);
  }
  throw new Error("Native model catalog is too large");
}
