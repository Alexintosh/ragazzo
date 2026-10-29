import { createHmac } from "node:crypto";
import { ConversationEngineError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ErosConversationEngineConfig } from "./eros-engine.js";
import { ErosConversationEngine, normalizeConversationEngineBaseUrl } from "./eros-engine.js";

const userId = "11111111-1111-4111-8111-111111111111";
const characterId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const instanceId = "44444444-4444-4444-8444-444444444444";
const clientMessageId = "55555555-5555-4555-8555-555555555555";
const config: ErosConversationEngineConfig = {
  id: "eros",
  baseUrl: "http://eros:8080/",
  jwtSecret: "synthetic-jwt-secret-for-offline-tests",
  callerSecret: "synthetic-caller-secret-for-offline-tests",
  characters: [{ id: characterId, name: "Character" }],
};
const input = { userId, sessionId, clientMessageId, text: "Hello" };

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

const meta = { type: "meta", message_id: "01J-FIRST", action_type: "reply" };
const delta = { type: "delta", message_id: "01J-FIRST", content: "Hello" };
const done = { type: "done", message_id: "01J-FIRST", truncated: false };
const final = { type: "final", filtered: false };

async function collect(engine: ErosConversationEngine, signal?: AbortSignal) {
  const events = [];
  for await (const event of engine.stream(input, signal)) events.push(event);
  return events;
}

describe("Eros conversation engine HTTP conformance", () => {
  it("provisions a resumable text session and signs a dedicated short-lived identity", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ session_id: sessionId, instance_id: instanceId, is_new: true }),
      );
    const engine = new ErosConversationEngine(config, { fetch });
    expect(await engine.provision({ userId, characterId })).toEqual({ sessionId, instanceId });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("http://eros:8080/comp/chat/start");
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(String(request?.body))).toEqual({ genome_id: characterId, channel: "text" });
    const headers = new Headers(request?.headers);
    expect(headers.get("x-caller-secret")).toBe(config.callerSecret);
    const token = headers.get("authorization")!.slice(7);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.sub).toBe(userId);
    expect(claims.exp - claims.iat).toBe(300);
    expect(signature).toBe(
      createHmac("sha256", config.jwtSecret).update(`${header}.${payload}`).digest("base64url"),
    );
    expect(engine.capabilities).toEqual({ streaming: true, tools: false, cancel: false });
  });

  it("sends only the current turn and reuses the supplied durable id on replay", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => sse([meta, delta, done, final]));
    const engine = new ErosConversationEngine(config, { fetch });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await collect(engine)).toEqual([
        { type: "text", text: "Hello" },
        { type: "final", text: "Hello", ghost: false, truncated: false },
      ]);
    }
    expect(fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)))).toEqual([
      { content: "Hello", client_msg_id: clientMessageId },
      { content: "Hello", client_msg_id: clientMessageId },
    ]);
  });

  it("parses split UTF-8, CRLF, multi-line data, comments and unknown presentation frames", async () => {
    const wire = new TextEncoder().encode(
      `: ping\r\n\r\ndata: ${JSON.stringify(meta)}\r\n\r\n` +
        'data: {"type":"future_frame",\r\ndata: "secret":"ignored"}\r\n\r\n' +
        `data: ${JSON.stringify({ ...delta, content: "Caffè ☕" })}\r\n\r\n` +
        `data: ${JSON.stringify(done)}\r\n\r\ndata: ${JSON.stringify(final)}\r\n\r\n`,
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    expect((await collect(new ErosConversationEngine(config, { fetch }))).at(-1)).toEqual({
      type: "final",
      text: "Caffè ☕",
      ghost: false,
      truncated: false,
    });
  });

  it("replaces superseded filter output and provides authoritative final text", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse([
          meta,
          delta,
          { ...done, truncated: true },
          { ...meta, message_id: "01J-SECOND", continues_from: null },
          { ...delta, message_id: "01J-SECOND", content: "Replacement" },
          { ...done, message_id: "01J-SECOND" },
          final,
        ]),
      );
    expect(await collect(new ErosConversationEngine(config, { fetch }))).toEqual([
      { type: "text", text: "Hello" },
      { type: "replace", text: "" },
      { type: "text", text: "Replacement" },
      { type: "final", text: "Replacement", ghost: false, truncated: false },
    ]);
  });

  it("keeps persisted continuation text while reporting terminal truncation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse([
          meta,
          delta,
          { ...done, truncated: true },
          { ...meta, message_id: "01J-SECOND", continues_from: meta.message_id },
          { ...delta, message_id: "01J-SECOND", content: " again" },
          { ...done, message_id: "01J-SECOND", truncated: true },
          final,
        ]),
      );
    expect((await collect(new ErosConversationEngine(config, { fetch }))).at(-1)).toEqual({
      type: "final",
      text: "Hello again",
      ghost: false,
      truncated: true,
    });
  });

  it.each([
    [{ ...meta, action_type: "ghost" }, done, final],
    [meta, { ...done, ghost_fallback: true }, final],
  ])("preserves explicit silent and fallback outcomes", async (...frames) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(frames));
    expect((await collect(new ErosConversationEngine(config, { fetch }))).at(-1)).toEqual({
      type: "final",
      text: "",
      ghost: true,
      truncated: false,
    });
  });

  it.each([
    [409, "duplicate_in_progress", "duplicate_in_progress", true],
    [409, "duplicate_failed", "duplicate_failed", false],
    [403, "forbidden", "failed", false],
    [422, "unprocessable", "failed", false],
    [429, "rate_limited", "unavailable", true],
    [503, "internal", "uncertain", true],
    [302, "redirect", "uncertain", true],
  ])(
    "classifies HTTP %s %s without leaking upstream diagnostics",
    async (status, upstream, code, retryable) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          Response.json({ code: upstream, message: "private upstream diagnostic" }, { status }),
        );
      const promise = collect(new ErosConversationEngine(config, { fetch }));
      await expect(promise).rejects.toMatchObject({ code, retryable });
      await expect(promise).rejects.not.toThrow("private upstream diagnostic");
    },
  );

  it.each([
    [meta, delta, done],
    [meta, delta, { ...done, message_id: "wrong" }, final],
    [delta, done, final],
    [meta, delta, final],
    [meta, meta, done, final],
  ])("treats incomplete or malformed turn protocols as uncertain", async (...frames) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(frames));
    await expect(collect(new ErosConversationEngine(config, { fetch }))).rejects.toMatchObject({
      code: "uncertain",
    });
  });

  it("treats an in-band error as terminal failure even after HTTP 200 and partial text", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse([meta, delta, { type: "error", retryable: true, message: "private error" }]),
      );
    await expect(collect(new ErosConversationEngine(config, { fetch }))).rejects.toMatchObject({
      code: "failed",
    });
  });

  it("refuses unexpected content types and bounded frame/input overflows", async () => {
    for (const response of [
      Response.json({ text: "not SSE" }),
      new Response(`data: ${"x".repeat(128 * 1024 + 1)}`, {
        headers: { "content-type": "text/event-stream" },
      }),
      new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(collect(new ErosConversationEngine(config, { fetch }))).rejects.toMatchObject({
        code: "uncertain",
      });
    }
  });

  it("bounds the complete response as well as each frame", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(": heartbeat\n\n".repeat(200_000), {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await expect(collect(new ErosConversationEngine(config, { fetch }))).rejects.toMatchObject({
      code: "uncertain",
    });
  });

  it("aborts transport on the deadline and leaves detached acceptance uncertain", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, request) => {
      return new Promise<Response>((_resolve, reject) => {
        request?.signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), {
          once: true,
        });
      });
    });
    const engine = new ErosConversationEngine(config, { fetch, timeoutMs: 5 });
    await expect(collect(engine)).rejects.toMatchObject({ code: "uncertain", retryable: true });
  });

  it("does not claim upstream cancellation when its caller disconnects", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, request) => {
      return new Promise<Response>((_resolve, reject) => {
        request?.signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), {
          once: true,
        });
        controller.abort();
      });
    });
    const engine = new ErosConversationEngine(config, { fetch });
    await expect(collect(engine, controller.signal)).rejects.toBeInstanceOf(
      ConversationEngineError,
    );
    expect(engine.capabilities.cancel).toBe(false);
  });

  it("rejects invalid identities, arbitrary character IDs and oversized current turns before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const engine = new ErosConversationEngine(config, { fetch });
    await expect(engine.provision({ userId, characterId: instanceId })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(engine.provision({ userId: "not-uuid", characterId })).rejects.toMatchObject({
      code: "invalid_request",
    });
    for (const invalid of [
      { ...input, clientMessageId: "cuid-is-too-short" },
      { ...input, sessionId: "../other-session" },
      { ...input, text: "a".repeat(4097) },
      { ...input, text: "   " },
    ]) {
      const events = async () => {
        for await (const _event of engine.stream(invalid)) {
          /* drain */
        }
      };
      await expect(events()).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "ftp://eros",
    "https://user:secret@eros",
    "https://eros/path?secret=x",
    "https://eros/#fragment",
    "http://public.example",
    "http://169.254.169.254",
    "https://metadata.google.internal",
  ])("refuses unsafe deployment endpoints: %s", (url) => {
    expect(() => normalizeConversationEngineBaseUrl(url)).toThrow();
  });
});
