import { createHmac } from "node:crypto";
import type {
  ConversationEngine,
  ConversationEngineBinding,
  ConversationEngineCharacter,
  ConversationEngineEvent,
} from "@rakazo/adapter-kit";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import type {
  ConversationEngineInspection,
  ConversationEngineSettings,
  UpdateConversationEngineState,
} from "@rakazo/contracts";
import {
  ConversationEngineAxesSchema,
  ConversationEngineItemNameSchema,
  ConversationEngineSettingsSchema,
  ipVersion,
  isCloudMetadataHost,
  isLinkLocalAddress,
  isLoopbackHost,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import { z } from "zod";
import {
  parseErosAction,
  parseErosDebug,
  parseErosInspection,
  parseErosItem,
} from "./eros-engine-inspection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_CHARS = 128 * 1024;
const MAX_TEXT_CHARS = 128 * 1024;
const MAX_JSON_BYTES = 16 * 1024;

export interface ErosConversationEngineConfig {
  id: "eros";
  baseUrl: string;
  jwtSecret: string;
  callerSecret?: string;
  debugBridge?: { baseUrl: string; secret: string };
  characters: readonly ConversationEngineCharacter[];
}

export interface ConversationEngineTransportOptions {
  fetch?: typeof globalThis.fetch;
  /** Test/embedding override, always bounded to ten minutes. */
  timeoutMs?: number;
}

/** Only the deployment composition root supplies this URL, never a bot or request. */
export function normalizeConversationEngineBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid conversation engine service URL");
  }
  const hostname = normalizeHost(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isCloudMetadataHost(hostname) ||
    (ipVersion(hostname) !== 0 && isLinkLocalAddress(hostname))
  ) {
    throw new Error("Invalid conversation engine service URL");
  }
  // Private services may use Docker DNS or an explicitly configured internal host.
  // Credentials sent to public services require TLS.
  const privateHttp =
    isLoopbackHost(hostname) ||
    (ipVersion(hostname) !== 0 && isNonPublicAddress(hostname)) ||
    (!hostname.includes(".") && ipVersion(hostname) === 0) ||
    hostname.endsWith(".internal");
  if (url.protocol === "http:" && !privateHttp) {
    throw new Error("Conversation engine public services require HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

export function isConversationEngineUuid(value: string): boolean {
  return UUID.test(value);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConversationEngineError("uncertain", true);
  }
  return value as Record<string, unknown>;
}

function requestSettings(raw: ConversationEngineSettings | undefined) {
  const result = ConversationEngineSettingsSchema.safeParse(raw ?? {});
  if (!result.success) throw new ConversationEngineError("invalid_request");
  const settings = result.data;
  return {
    ...(settings.tier === undefined ? {} : { tier: settings.tier }),
    ...(settings.promptTraits === undefined ? {} : { prompt_traits: settings.promptTraits }),
    ...(settings.memoryScope === undefined ? {} : { memory_scope: settings.memoryScope }),
    ...(settings.affinityScope === undefined ? {} : { affinity_scope: settings.affinityScope }),
    ...(settings.outfit === undefined ? {} : { outfit: settings.outfit }),
  };
}

async function readJson(
  response: Response,
  maxBytes = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new ConversationEngineError("uncertain", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ConversationEngineError("uncertain", true);
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return object(JSON.parse(body));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function requestLifetime(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}

/** One SSE event per yield, with limits before decoding/parsing untrusted data. */
async function* frames(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new ConversationEngineError("uncertain", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  let data: string[] = [];
  let frameChars = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new ConversationEngineError("uncertain", true);
      buffer += decoder.decode(chunk.value, { stream: true });
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        frameChars += line.length;
        if (frameChars > MAX_FRAME_CHARS) throw new ConversationEngineError("uncertain", true);
        if (line === "") {
          if (data.length) yield object(JSON.parse(data.join("\n")));
          data = [];
          frameChars = 0;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (buffer.length + frameChars > MAX_FRAME_CHARS) {
        throw new ConversationEngineError("uncertain", true);
      }
    }
    // An unfinished event is never a terminal success. The caller requires final.
    decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** HTTP integration with Eros 2.5.2; no upstream runtime or source is embedded. */
export class ErosConversationEngine implements ConversationEngine {
  readonly id = "eros";
  readonly name = "Eros";
  readonly capabilities = Object.freeze({ streaming: true, tools: false, cancel: false });
  readonly characters: readonly ConversationEngineCharacter[];
  readonly #baseUrl: string;
  readonly #jwtSecret: string;
  readonly #callerSecret: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #debugBridge: { baseUrl: string; secret: string } | undefined;

  constructor(
    config: ErosConversationEngineConfig,
    options: ConversationEngineTransportOptions = {},
  ) {
    this.#baseUrl = normalizeConversationEngineBaseUrl(config.baseUrl);
    if (config.debugBridge && config.debugBridge.secret.length < 32)
      throw new Error("Conversation engine debug credentials require at least 32 characters");
    this.#debugBridge = config.debugBridge
      ? {
          ...config.debugBridge,
          baseUrl: normalizeConversationEngineBaseUrl(config.debugBridge.baseUrl),
        }
      : undefined;
    if (config.jwtSecret.length < 32 || (config.callerSecret && config.callerSecret.length < 32)) {
      throw new Error("Conversation engine credentials require at least 32 characters");
    }
    if (
      !config.characters.length ||
      config.characters.some((character) => !UUID.test(character.id) || !character.name.trim()) ||
      new Set(config.characters.map((character) => character.id)).size !== config.characters.length
    ) {
      throw new Error("Invalid conversation engine characters");
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new Error("Invalid conversation engine timeout");
    }
    this.#jwtSecret = config.jwtSecret;
    this.#callerSecret = config.callerSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
    this.characters = Object.freeze(
      config.characters.map(({ id, name }) => Object.freeze({ id, name: name.trim() })),
    );
  }

  #headers(userId: string, accept: string): Record<string, string> {
    if (!UUID.test(userId)) throw new ConversationEngineError("invalid_request");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, iat: now, exp: now + 300, iss: "rakazo", aud: "eros-engine" }),
    ).toString("base64url");
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", this.#jwtSecret).update(body).digest("base64url");
    return {
      authorization: `Bearer ${body}.${signature}`,
      "content-type": "application/json",
      accept,
      ...(this.#callerSecret ? { "x-caller-secret": this.#callerSecret } : {}),
    };
  }

  #binding(input: ConversationEngineBinding) {
    if (
      ![input.userId, input.sessionId, input.instanceId, input.characterId].every((id) =>
        UUID.test(id),
      ) ||
      !this.characters.some(({ id }) => id === input.characterId)
    )
      throw new ConversationEngineError("invalid_request");
  }

  #debugHeaders(input: ConversationEngineBinding): Record<string, string> {
    if (!this.#debugBridge) throw new ConversationEngineError("unavailable");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: input.userId,
        iat: now,
        exp: now + 60,
        aud: "rakazo-eros-debug",
        session_id: input.sessionId,
        instance_id: input.instanceId,
        genome_id: input.characterId,
      }),
    ).toString("base64url");
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", this.#jwtSecret).update(body).digest("base64url");
    return {
      authorization: `Bearer ${body}.${signature}`,
      "x-debug-secret": this.#debugBridge.secret,
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  async #debugRequest(
    input: ConversationEngineBinding,
    signal: AbortSignal,
    patch?: Record<string, unknown>,
  ) {
    if (!this.#debugBridge) throw new ConversationEngineError("unavailable");
    const response = await this.#fetch(
      `${this.#debugBridge.baseUrl}/v1/sessions/${input.sessionId}/debug`,
      {
        method: patch ? "PATCH" : "GET",
        headers: this.#debugHeaders(input),
        redirect: "error",
        signal,
        ...(patch ? { body: JSON.stringify(patch) } : {}),
      },
    );
    if (response.status === 409) {
      let code: unknown;
      try {
        code = (await readJson(response)).error;
      } catch {
        /* Safe error only. */
      }
      throw new ConversationEngineError(code === "busy" ? "busy" : "conflict");
    }
    await this.#checkResponse(response);
    return readJson(response, 256 * 1024);
  }

  async inspect(
    input: ConversationEngineBinding,
    signal?: AbortSignal,
  ): Promise<ConversationEngineInspection> {
    this.#binding(input);
    const lifetime = requestLifetime(signal, Math.min(this.#timeoutMs, 30_000));
    const paths = [
      `/v2/comp/instance/${input.instanceId}/insight/character`,
      `/bff/v1/comp/affinity/${input.sessionId}`,
      `/bff/v1/comp/affinity/${input.sessionId}/event`,
      `/v2/comp/session/${input.sessionId}/effects`,
      `/v2/comp/instance/${input.instanceId}/insight/user`,
      `/v2/comp/instance/${input.instanceId}/items`,
    ];
    try {
      const results = await Promise.allSettled([
        ...paths.map(async (path) => {
          const response = await this.#fetch(`${this.#baseUrl}${path}`, {
            method: "GET",
            headers: this.#headers(input.userId, "application/json"),
            redirect: "error",
            signal: lifetime.signal,
          });
          await this.#checkResponse(response);
          return readJson(response, 256 * 1024);
        }),
        this.#debugBridge ? this.#debugRequest(input, lifetime.signal) : Promise.resolve(null),
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const values = results.map((result) => (result.status === "fulfilled" ? result.value : null));
      return parseErosInspection(
        input.sessionId,
        input.instanceId,
        input.characterId,
        values.slice(0, 6) as Record<string, unknown>[],
        values[6]!,
      );
    } catch (error) {
      if (error instanceof ConversationEngineError) throw error;
      throw new ConversationEngineError("unavailable", true);
    } finally {
      lifetime.dispose();
    }
  }

  async #nativeMutation(
    input: ConversationEngineBinding,
    path: string,
    method: "POST" | "DELETE",
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ) {
    this.#binding(input);
    const lifetime = requestLifetime(signal, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: this.#headers(input.userId, "application/json"),
        redirect: "error",
        signal: lifetime.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      await this.#checkResponse(response);
      return method === "DELETE" ? null : await readJson(response, 256 * 1024);
    } catch (error) {
      if (error instanceof ConversationEngineError) throw error;
      throw new ConversationEngineError("uncertain");
    } finally {
      lifetime.dispose();
    }
  }

  async addItem(
    input: ConversationEngineBinding & { kind: "item" | "clothing"; name: string },
    signal?: AbortSignal,
  ) {
    const item = z
      .object({ kind: z.enum(["item", "clothing"]), name: ConversationEngineItemNameSchema })
      .safeParse(input);
    if (!item.success) throw new ConversationEngineError("invalid_request");
    const result = await this.#nativeMutation(
      input,
      `/v2/comp/instance/${input.instanceId}/items`,
      "POST",
      item.data,
      signal,
    );
    try {
      return parseErosItem(result);
    } catch {
      throw new ConversationEngineError("uncertain");
    }
  }

  async deleteItem(input: ConversationEngineBinding & { itemId: string }, signal?: AbortSignal) {
    if (!UUID.test(input.itemId)) throw new ConversationEngineError("invalid_request");
    await this.#nativeMutation(
      input,
      `/v2/comp/instance/${input.instanceId}/items/${input.itemId}`,
      "DELETE",
      undefined,
      signal,
    );
  }

  async openSession(
    input: ConversationEngineBinding & {
      actionId: string;
      occasion?: "first_meet" | "returning" | "just_opened";
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ) {
    if (
      !UUID.test(input.actionId) ||
      (input.occasion !== undefined &&
        !["first_meet", "returning", "just_opened"].includes(input.occasion))
    )
      throw new ConversationEngineError("invalid_request");
    const { outfit: _outfit, ...settings } = requestSettings(input.settings);
    const body = {
      ...settings,
      ...(input.occasion ? { occasion: input.occasion, open_key: input.actionId } : {}),
    };
    const result = await this.#nativeMutation(
      input,
      `/v2/comp/session/${input.sessionId}/open`,
      "POST",
      body,
      signal,
    );
    try {
      return parseErosAction(result!, "open");
    } catch {
      throw new ConversationEngineError("uncertain");
    }
  }

  async drawEvent(
    input: ConversationEngineBinding & {
      actionId: string;
      kinds?: string[];
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ) {
    if (
      !UUID.test(input.actionId) ||
      (input.kinds !== undefined &&
        (!Array.isArray(input.kinds) ||
          input.kinds.length > 64 ||
          input.kinds.some(
            (kind) => !/^[a-z_]{1,64}$/.test(kind) || ["taking_space", "fell_out"].includes(kind),
          )))
    )
      throw new ConversationEngineError("invalid_request");
    const body = {
      ...requestSettings(input.settings),
      event_key: input.actionId,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    };
    const result = await this.#nativeMutation(
      input,
      `/v2/comp/session/${input.sessionId}/events`,
      "POST",
      body,
      signal,
    );
    try {
      return parseErosAction(result!, "event");
    } catch {
      throw new ConversationEngineError("uncertain");
    }
  }

  async updateState(
    input: ConversationEngineBinding &
      Omit<UpdateConversationEngineState, "botId" | "historyGeneration">,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#binding(input);
    const axes = ConversationEngineAxesSchema.parse(input.axes);
    const grades = z
      .object({
        warmthGrade: z.number().int().min(1).max(3),
        patienceGrade: z.number().int().min(1).max(3),
        expectedRevision: z.string().min(1).max(128),
        elapsedHours: z.number().min(0).max(720).optional(),
      })
      .parse(input);
    const lifetime = requestLifetime(signal, Math.min(this.#timeoutMs, 30_000));
    try {
      const result = await this.#debugRequest(input, lifetime.signal, { ...axes, ...grades });
      parseErosDebug(input.sessionId, input.instanceId, input.characterId, result);
    } catch (error) {
      if (error instanceof ConversationEngineError) throw error;
      throw new ConversationEngineError("uncertain");
    } finally {
      lifetime.dispose();
    }
  }

  async #checkResponse(response: Response): Promise<void> {
    if (response.ok) return;
    let code: unknown;
    try {
      code = (await readJson(response)).code;
    } catch {
      // An error body is diagnostic only; never copy it into a user-visible error.
    }
    if (response.status === 409 && code === "duplicate_in_progress") {
      throw new ConversationEngineError("duplicate_in_progress", true);
    }
    if (response.status === 409 && code === "duplicate_failed") {
      throw new ConversationEngineError("duplicate_failed");
    }
    if (response.status === 429) throw new ConversationEngineError("unavailable", true);
    if (response.status >= 400 && response.status < 500) {
      throw new ConversationEngineError("failed");
    }
    throw new ConversationEngineError("uncertain", true);
  }

  async provision(input: { userId: string; characterId: string }, signal?: AbortSignal) {
    if (!this.characters.some((character) => character.id === input.characterId)) {
      throw new ConversationEngineError("invalid_request");
    }
    const headers = this.#headers(input.userId, "application/json");
    const lifetime = requestLifetime(signal, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/comp/chat/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ genome_id: input.characterId, channel: "text" }),
        redirect: "error",
        signal: lifetime.signal,
      });
      await this.#checkResponse(response);
      const result = await readJson(response);
      if (
        typeof result.session_id !== "string" ||
        !UUID.test(result.session_id) ||
        typeof result.instance_id !== "string" ||
        !UUID.test(result.instance_id)
      ) {
        throw new ConversationEngineError("uncertain", true);
      }
      return { sessionId: result.session_id, instanceId: result.instance_id };
    } catch (error) {
      if (error instanceof ConversationEngineError) throw error;
      throw new ConversationEngineError("uncertain", true);
    } finally {
      lifetime.dispose();
    }
  }

  async *stream(
    input: {
      userId: string;
      sessionId: string;
      clientMessageId: string;
      text: string;
      settings?: ConversationEngineSettings;
    },
    signal?: AbortSignal,
  ): AsyncGenerator<ConversationEngineEvent> {
    if (
      !UUID.test(input.sessionId) ||
      !UUID.test(input.clientMessageId) ||
      input.text.length > 8192 ||
      !input.text.trim() ||
      [...input.text].length > 4096
    ) {
      throw new ConversationEngineError("invalid_request");
    }
    const headers = this.#headers(input.userId, "text/event-stream");
    const settings = requestSettings(input.settings);
    const lifetime = requestLifetime(signal, this.#timeoutMs);
    let text = "";
    let messageId: string | undefined;
    let done = false;
    let ghost = false;
    let truncated = false;
    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/comp/chat/${input.sessionId}/message/stream`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: input.text,
            client_msg_id: input.clientMessageId,
            ...settings,
          }),
          redirect: "error",
          signal: lifetime.signal,
        },
      );
      await this.#checkResponse(response);
      if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel().catch(() => {});
        throw new ConversationEngineError("uncertain", true);
      }
      for await (const frame of frames(response)) {
        switch (frame.type) {
          case "meta": {
            if (typeof frame.message_id !== "string" || !frame.message_id) {
              throw new ConversationEngineError("uncertain", true);
            }
            if (messageId !== undefined && !done) {
              throw new ConversationEngineError("uncertain", true);
            }
            if (messageId !== undefined && frame.continues_from == null) {
              text = "";
              yield { type: "replace", text };
            } else if (messageId !== undefined && frame.continues_from !== messageId) {
              throw new ConversationEngineError("uncertain", true);
            }
            messageId = frame.message_id;
            ghost = frame.action_type === "ghost";
            done = false;
            break;
          }
          case "delta": {
            if (
              !messageId ||
              done ||
              frame.message_id !== messageId ||
              typeof frame.content !== "string"
            ) {
              throw new ConversationEngineError("uncertain", true);
            }
            text += frame.content;
            if (text.length > MAX_TEXT_CHARS) throw new ConversationEngineError("uncertain", true);
            yield { type: "text", text: frame.content };
            break;
          }
          case "done": {
            if (
              !messageId ||
              done ||
              frame.message_id !== messageId ||
              typeof frame.truncated !== "boolean"
            ) {
              throw new ConversationEngineError("uncertain", true);
            }
            done = true;
            truncated = frame.truncated;
            ghost ||= frame.ghost_fallback === true;
            break;
          }
          case "final": {
            if (!messageId || !done) throw new ConversationEngineError("uncertain", true);
            // Eros persists text before final, then starts asynchronous memory and
            // affinity work. No API acknowledges completion of those background jobs.
            yield { type: "final", text, ghost, truncated };
            return;
          }
          case "error":
            throw new ConversationEngineError("failed");
          default:
            // Reasoning and future presentation frames never execute Rakazo tools.
            break;
        }
      }
      throw new ConversationEngineError("uncertain", true);
    } catch (error) {
      if (error instanceof ConversationEngineError) throw error;
      // A timeout, disconnect or malformed frame cannot prove the detached turn stopped.
      throw new ConversationEngineError("uncertain", true);
    } finally {
      lifetime.dispose();
    }
  }
}
