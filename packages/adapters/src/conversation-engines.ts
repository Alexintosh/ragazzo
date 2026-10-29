import type { ConversationEngine, ConversationEngineDescriptor } from "@rakazo/adapter-kit";
import { z } from "zod";
import type {
  ConversationEngineTransportOptions,
  ErosConversationEngineConfig,
} from "./eros-engine.js";
import { ErosConversationEngine, normalizeConversationEngineBaseUrl } from "./eros-engine.js";

const configuration = z
  .array(
    z.strictObject({
      id: z.literal("eros"),
      baseUrl: z.string().min(1).max(2048),
      jwtSecret: z.string().min(32).max(4096),
      callerSecret: z.string().min(32).max(4096).optional(),
      debugBridge: z
        .strictObject({
          baseUrl: z.string().min(1).max(2048),
          secret: z.string().min(32).max(4096),
        })
        .optional(),
      characters: z
        .array(z.strictObject({ id: z.uuid(), name: z.string().trim().min(1).max(120) }))
        .min(1)
        .max(500),
    }),
  )
  .max(20);

/** Deployment-only configuration. Errors never echo JSON because it contains secrets. */
export function parseConversationEngines(raw?: string): ErosConversationEngineConfig[] {
  if (!raw?.trim()) return [];
  try {
    if (raw.length > 256 * 1024) throw new Error();
    const configs = configuration.parse(JSON.parse(raw));
    if (new Set(configs.map((config) => config.id)).size !== configs.length) throw new Error();
    return configs.map((config) => {
      if (
        new Set(config.characters.map((character) => character.id)).size !==
        config.characters.length
      ) {
        throw new Error();
      }
      return {
        ...config,
        baseUrl: normalizeConversationEngineBaseUrl(config.baseUrl),
        ...(config.debugBridge
          ? {
              debugBridge: {
                ...config.debugBridge,
                baseUrl: normalizeConversationEngineBaseUrl(config.debugBridge.baseUrl),
              },
            }
          : {}),
      };
    });
  } catch {
    throw new Error("Invalid CONVERSATION_ENGINES configuration");
  }
}

export function createConversationEngines(
  env: { CONVERSATION_ENGINES?: string } = process.env,
  options: ConversationEngineTransportOptions = {},
): Map<string, ConversationEngine> {
  return new Map(
    parseConversationEngines(env.CONVERSATION_ENGINES).map((config) => [
      config.id,
      new ErosConversationEngine(config, options),
    ]),
  );
}

/** Explicit projection: never serialize adapter instances or raw deployment config. */
export function describeConversationEngines(
  engines: ReadonlyMap<string, ConversationEngine>,
): ConversationEngineDescriptor[] {
  return [...engines.values()].map(({ id, name, characters, capabilities }) => ({
    id,
    name,
    characters: characters.map(({ id: characterId, name: characterName }) => ({
      id: characterId,
      name: characterName,
    })),
    capabilities: { ...capabilities },
  }));
}
