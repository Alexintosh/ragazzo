import * as z from "zod";

export const ROLEPLAY_IMPORT_MAX_BYTES = 1_048_576;
export const ROLEPLAY_CONTINUITY_MAX_BYTES = 16_384;
export const RoleplayConversationStyleSchema = z.enum(["narrative", "chat"]);
export const RoleplayRelationshipSchema = z.strictObject({
  warmth: z.number().int().min(0).max(100),
  intimacy: z.number().int().min(0).max(100),
  love: z.number().int().min(0).max(100),
});
export type RoleplayRelationship = z.infer<typeof RoleplayRelationshipSchema>;
export const RoleplayRelationshipDebugSchema = z.strictObject({
  relationship: RoleplayRelationshipSchema,
  historyGeneration: z.number().int().nonnegative(),
  revision: z.string(),
});
export type RoleplayRelationshipDebug = z.infer<typeof RoleplayRelationshipDebugSchema>;
export const RoleplaySpontaneousSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  frequency: z.enum(["gentle", "balanced", "frequent"]),
  allowLateNight: z.boolean(),
});
export type RoleplaySpontaneousSettings = z.infer<typeof RoleplaySpontaneousSettingsSchema>;
export const RoleplayDatedEventSchema = z.strictObject({
  id: z.string().min(1).max(100),
  description: z.string().max(400),
  date: z.iso.date(),
  status: z.enum(["planned", "cancelled", "resolved"]),
  sourceMessageSeq: z.number().int().nonnegative(),
  sourceMessageAt: z.iso.datetime({ offset: true }),
});
export type RoleplayDatedEvent = z.infer<typeof RoleplayDatedEventSchema>;
export const RoleplayContinuitySchema = z
  .strictObject({
    scene: z.string().max(800),
    relationship: z.string().max(800),
    relationshipState: RoleplayRelationshipSchema.optional(),
    datedEvents: z.array(RoleplayDatedEventSchema).max(12).optional(),
    sharedDetails: z.array(z.string().max(400)).max(12),
    openThreads: z.array(z.string().max(400)).max(8),
    callbacks: z.array(z.string().max(400)).max(8),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= ROLEPLAY_CONTINUITY_MAX_BYTES,
    { message: "Story continuity exceeds the memory limit" },
  );
export type RoleplayContinuity = z.infer<typeof RoleplayContinuitySchema>;
const text = z.string().max(100_000);
export const BotKindSchema = z.enum(["agent", "roleplay"]);
export const RoleplayLorebookEntrySchema = z.object({
  keys: z.array(z.string().max(500)).max(100),
  secondaryKeys: z.array(z.string().max(500)).max(100),
  content: text,
  enabled: z.boolean(),
  constant: z.boolean(),
  selective: z.boolean(),
  caseSensitive: z.boolean(),
  insertionOrder: z.number().int().min(-100_000).max(100_000),
  position: z.enum(["before_char", "after_char"]),
});
export type RoleplayLorebookEntry = z.infer<typeof RoleplayLorebookEntrySchema>;
export const RoleplayMediaEntrySchema = z.strictObject({
  id: z.string().min(1).max(100),
  artifactId: z.string().min(1).max(200),
  description: z.string().trim().min(1).max(800),
  scene: z.string().max(400).optional(),
  enabled: z.boolean(),
});
export type RoleplayMediaEntry = z.infer<typeof RoleplayMediaEntrySchema>;
export const RoleplayMediaSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    allowSpontaneous: z.boolean(),
    normalIntervalTurns: z.number().int().min(1).max(100),
    storyIntervalTurns: z.number().int().min(1).max(100),
    album: z.array(RoleplayMediaEntrySchema).max(32),
  })
  .refine(
    (value) =>
      new Set(value.album.map((entry) => entry.id)).size === value.album.length &&
      new Set(value.album.map((entry) => entry.artifactId)).size === value.album.length,
    { message: "Album entries and artifacts must be unique" },
  );
export type RoleplayMediaSettings = z.infer<typeof RoleplayMediaSettingsSchema>;
export const RoleplayMediaStateSchema = z
  .strictObject({
    storyMode: z.boolean(),
    scene: z.string().max(800),
    revision: z.number().int().nonnegative(),
    lastImageTurn: z.number().int().nonnegative().nullable(),
    sentImageIds: z.array(z.string().min(1).max(100)).max(32),
    turn: z.number().int().nonnegative(),
  })
  .refine((value) => value.lastImageTurn === null || value.lastImageTurn <= value.turn, {
    message: "Image turn exceeds the current turn",
  });
export type RoleplayMediaState = z.infer<typeof RoleplayMediaStateSchema>;
export const RoleplayCharacterSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    conversationStyle: RoleplayConversationStyleSchema.optional(),
    spontaneous: RoleplaySpontaneousSettingsSchema.optional(),
    media: RoleplayMediaSettingsSchema.optional(),
    description: text,
    personality: text,
    scenario: text,
    exampleDialogue: text,
    firstMessage: text,
    systemPrompt: text,
    postHistoryInstructions: text,
    alternateGreetings: z.array(text).max(100),
    lorebook: z
      .object({
        name: z.string().max(500),
        description: text,
        scanDepth: z.number().int().min(0).max(100),
        tokenBudget: z.number().int().min(0).max(32_768),
        entries: z.array(RoleplayLorebookEntrySchema).max(500),
      })
      .nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= ROLEPLAY_IMPORT_MAX_BYTES,
    {
      message: "Character content exceeds the import limit",
    },
  );
export type RoleplayCharacter = z.infer<typeof RoleplayCharacterSchema>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a character JSON object");
  return value as Record<string, unknown>;
}
function string(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error("Character text fields must be strings");
  return value;
}
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  return z.array(z.string()).parse(value);
}
function bool(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : z.boolean().parse(value);
}
function number(value: unknown, fallback: number): number {
  return value === undefined ? fallback : z.number().int().parse(value);
}

/** Import text-only plain, Character Card v2/v3, and Risu character JSON. No extensions execute. */
export function parseRoleplayCharacterJson(source: string): {
  character: RoleplayCharacter;
  warnings: string[];
} {
  if (new TextEncoder().encode(source).length > ROLEPLAY_IMPORT_MAX_BYTES)
    throw new Error("Character JSON must be at most 1 MB");
  const root = record(JSON.parse(source));
  const warnings = new Set<string>();
  if (root.spec !== undefined && root.spec !== "chara_card_v2" && root.spec !== "chara_card_v3")
    throw new Error("Unsupported character card format");
  const data = root.spec ? record(root.data) : root;
  const extensions = data.extensions;
  let extensionStyle: unknown;
  if (extensions) {
    const entries = record(extensions);
    let unsupported = false;
    for (const [namespace, value] of Object.entries(entries)) {
      if (namespace !== "rakazo") {
        unsupported = true;
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        unsupported = true;
        continue;
      }
      const rakazo = record(value);
      extensionStyle = rakazo.conversation_style;
      if (Object.keys(rakazo).some((key) => key !== "conversation_style")) unsupported = true;
    }
    if (unsupported)
      warnings.add("Character extensions, scripts, triggers, and assets are not imported.");
  }
  const conversationStyle =
    data.conversationStyle === undefined ? extensionStyle : data.conversationStyle;
  for (const field of [
    "scripts",
    "triggerscript",
    "customscript",
    "regex",
    "assets",
    "emotionImages",
    "additionalAssets",
    "backgroundHTML",
  ]) {
    if (data[field] !== undefined || root[field] !== undefined)
      warnings.add("Character scripts, triggers, regex transforms, and assets are not imported.");
  }
  if (data.group_only_greetings !== undefined)
    warnings.add("Group-only greetings are not imported.");
  if (data.media !== undefined || root.media !== undefined)
    warnings.add("Character album images are not imported. Add them in settings.");
  if (data.spontaneous !== undefined || root.spontaneous !== undefined)
    warnings.add("Spontaneous messaging settings are not imported. Enable them in settings.");
  const bookValue = data.character_book ?? data.lorebook ?? data.globalLore;
  let lorebook: RoleplayCharacter["lorebook"] = null;
  if (bookValue !== undefined && bookValue !== null) {
    const book = Array.isArray(bookValue) ? { entries: bookValue } : record(bookValue);
    if (book.recursive_scanning === true)
      warnings.add("Recursive lorebook scanning is not supported.");
    if (book.extensions && Object.keys(record(book.extensions)).length)
      warnings.add("Lorebook extensions are not imported.");
    const entries = z
      .array(z.unknown())
      .max(500)
      .parse(book.entries ?? [])
      .map((value, index) => {
        const entry = record(value);
        if (entry.extensions && Object.keys(record(entry.extensions)).length)
          warnings.add("Lorebook entry extensions are not imported.");
        const position = entry.position ?? "before_char";
        if (position !== "before_char" && position !== "after_char")
          warnings.add("Unsupported lorebook positions use before-character placement.");
        if (entry.use_regex === true)
          warnings.add("Lorebook regex keys use literal text matching.");
        const keys =
          typeof entry.key === "string"
            ? entry.key
                .split(",")
                .map((key) => key.trim())
                .filter(Boolean)
            : strings(entry.keys);
        return {
          keys,
          secondaryKeys: strings(entry.secondary_keys ?? entry.secondaryKeys),
          content: string(entry.content),
          enabled: bool(entry.enabled, entry.mode !== "disabled"),
          constant: bool(entry.constant ?? entry.alwaysActive, false),
          selective: bool(entry.selective, false),
          caseSensitive: bool(entry.case_sensitive ?? entry.caseSensitive, false),
          insertionOrder: number(entry.insertion_order ?? entry.insertorder ?? entry.order, index),
          position: position === "after_char" ? ("after_char" as const) : ("before_char" as const),
        };
      });
    lorebook = {
      name: string(book.name),
      description: string(book.description),
      scanDepth: number(book.scan_depth ?? book.scanDepth, 2),
      tokenBudget: number(book.token_budget ?? book.tokenBudget, 2048),
      entries,
    };
  }
  const character = RoleplayCharacterSchema.parse({
    name: string(data.name),
    ...(conversationStyle === undefined ? {} : { conversationStyle }),
    description: string(data.description ?? data.desc),
    personality: string(data.personality),
    scenario: string(data.scenario),
    exampleDialogue: string(data.mes_example ?? data.exampleMessage),
    firstMessage: string(data.first_mes ?? data.firstMessage),
    systemPrompt: string(data.system_prompt ?? data.systemPrompt),
    postHistoryInstructions: string(data.post_history_instructions ?? data.postHistoryInstructions),
    alternateGreetings: strings(data.alternate_greetings ?? data.alternateGreetings),
    lorebook,
  });
  return { character, warnings: [...warnings] };
}
