import type {
  ConversationEngineActionResult,
  ConversationEngineInspection,
  ConversationEngineItem,
  ConversationEngineSettings,
  UpdateConversationEngineState,
} from "@rakazo/contracts";

export interface ConversationEngineBinding {
  userId: string;
  sessionId: string;
  instanceId: string;
  characterId: string;
}

/** A stateful conversational service owns its prompt, transcript and memory.
 * It is selected before local agent context construction, not as an LLM transport. */
export interface ConversationEngineCapabilities {
  streaming: boolean;
  tools: boolean;
  /** Whether the service can cancel an accepted turn, rather than just its HTTP connection. */
  cancel: boolean;
}

export interface ConversationEngineCharacter {
  id: string;
  name: string;
}

/** Safe to expose to clients; credentials and service addresses never belong here. */
export interface ConversationEngineDescriptor {
  id: string;
  name: string;
  characters: readonly ConversationEngineCharacter[];
  capabilities: ConversationEngineCapabilities;
}

export type ConversationEngineEvent =
  | { type: "text"; text: string }
  | { type: "replace"; text: string }
  | {
      type: "final";
      /** Authoritative text, including any upstream replacement of streamed output. */
      text: string;
      ghost: boolean;
      truncated: boolean;
    };

export interface ConversationEngine extends ConversationEngineDescriptor {
  addItem?(
    input: ConversationEngineBinding & { kind: "item" | "clothing"; name: string },
    signal?: AbortSignal,
  ): Promise<ConversationEngineItem>;
  deleteItem?(
    input: ConversationEngineBinding & { itemId: string },
    signal?: AbortSignal,
  ): Promise<void>;
  openSession?(
    input: ConversationEngineBinding & {
      actionId: string;
      occasion?: "first_meet" | "returning" | "just_opened";
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ): Promise<ConversationEngineActionResult>;
  drawEvent?(
    input: ConversationEngineBinding & {
      actionId: string;
      kinds?: string[];
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ): Promise<ConversationEngineActionResult>;
  inspect?(
    input: ConversationEngineBinding,
    signal?: AbortSignal,
  ): Promise<ConversationEngineInspection>;
  updateState?(
    input: ConversationEngineBinding &
      Omit<UpdateConversationEngineState, "botId" | "historyGeneration">,
    signal?: AbortSignal,
  ): Promise<void>;
  provision(
    input: { userId: string; characterId: string },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; instanceId: string }>;
  stream(
    input: {
      userId: string;
      sessionId: string;
      clientMessageId: string;
      text: string;
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEngineEvent>;
}

export type ConversationEngineErrorCode =
  | "unavailable"
  | "conflict"
  | "busy"
  | "invalid_request"
  | "duplicate_in_progress"
  | "duplicate_failed"
  | "uncertain"
  | "failed";

/** Safe messages only: never include upstream bodies, credentials or configuration. */
export class ConversationEngineError extends Error {
  constructor(
    public readonly code: ConversationEngineErrorCode,
    public readonly retryable = false,
  ) {
    super(`Conversation engine: ${code}`);
    this.name = "ConversationEngineError";
  }
}
