import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ErosConversationEngine } from "./eros-engine.js";

const binding = {
  userId: "11111111-1111-4111-8111-111111111111",
  characterId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  instanceId: "44444444-4444-4444-8444-444444444444",
};
const config = {
  id: "eros" as const,
  baseUrl: "http://eros:8080",
  jwtSecret: "synthetic-offline-jwt-secret-value",
  characters: [{ id: binding.characterId, name: "Aster" }],
  debugBridge: { baseUrl: "http://debug:8081", secret: "synthetic-offline-debug-secret-value" },
};
const axes = { trust: 0.2, intrigue: 0.3, intimacy: 0.1, tension: 0.4 };
const time = "2026-01-01T00:00:00Z";
const debug = {
  sessionId: binding.sessionId,
  instanceId: binding.instanceId,
  characterId: binding.characterId,
  characterName: "Aster",
  systemPrompt: "A fictional character.",
  tipPersonality: null,
  timezone: "Europe/Lisbon",
  feelingClause: "Curious and guarded.",
  feelingClauseAt: time,
  axes,
  warmthGrade: 2,
  patienceGrade: 1,
  revision: "revision-1",
  editable: true,
  privateField: "must never reach a client",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/debug")) return Response.json({ ...debug, ...overrides });
    if (path.endsWith("/character"))
      return Response.json({
        instance_id: binding.instanceId,
        location: null,
        occupation: null,
        current_situation: null,
        desires: null,
        vulnerabilities: null,
        habits: null,
        personal_values: null,
        likes: [],
        dislikes: [],
        relationships: [],
        updated_at: null,
      });
    if (path.endsWith("/event"))
      return Response.json({ session_id: binding.sessionId, event: null });
    if (path.endsWith("/effects"))
      return Response.json({
        needs: { emotional: "high" },
        as_of: time,
        changes_at: null,
        effects: [{ private: "ignored" }],
      });
    return Response.json({
      session_id: binding.sessionId,
      affinity: {
        ...axes,
        warmth: 0.5,
        patience: 0.6,
        ghost_streak: 0,
        total_ghosts: 1,
        updated_at: time,
        bond: 0.2,
        chemistry: 0.1,
        bond_tier: 1,
        chem_tier: 1,
        bond_label: "acquaintance",
        chemistry_label: "spark",
      },
    });
  });
  return { fetch, engine: new ErosConversationEngine(config, { fetch }) };
}

describe("Eros engine inspection boundary", () => {
  it("reads actual feeling separately from needs and scopes bridge credentials to the exact binding", async () => {
    const f = fixture();
    const result = await f.engine.inspect(binding);
    expect(result.debug?.feeling).toBe("Curious and guarded.");
    expect(result.emotionalNeed).toBe("high");
    expect(result.affinity?.warmth).toBe(0.5);
    expect(result.debug?.axes).toEqual(axes);
    expect(JSON.stringify(result)).not.toContain("privateField");
    expect(JSON.stringify(result)).not.toContain(binding.sessionId);
    const [url, request] = f.fetch.mock.calls.find(([url]) => String(url).includes("debug:8081"))!;
    expect(String(url)).toBe(`http://debug:8081/v1/sessions/${binding.sessionId}/debug`);
    expect(request?.redirect).toBe("error");
    const headers = new Headers(request?.headers);
    expect(headers.get("x-debug-secret")).toBe(config.debugBridge.secret);
    const [header, payload, signature] = headers.get("authorization")!.slice(7).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toMatchObject({
      sub: binding.userId,
      aud: "rakazo-eros-debug",
      session_id: binding.sessionId,
      instance_id: binding.instanceId,
      genome_id: binding.characterId,
    });
    expect(claims.exp - claims.iat).toBe(60);
    expect(signature).toBe(
      createHmac("sha256", config.jwtSecret).update(`${header}.${payload}`).digest("base64url"),
    );
    for (const [nativeUrl, nativeRequest] of f.fetch.mock.calls.filter(
      ([url]) => !String(url).includes("debug:8081"),
    )) {
      expect(String(nativeUrl)).toContain("http://eros:8080/");
      expect(new Headers(nativeRequest?.headers).has("x-debug-secret")).toBe(false);
    }
  });

  it("rejects a returned identity mismatch with a safe error", async () => {
    await expect(
      fixture({ instanceId: binding.characterId }).engine.inspect(binding),
    ).rejects.toThrow("Conversation engine: unavailable");
  });

  it("uses native-only reads when no bridge is configured", async () => {
    const f = fixture();
    const engine = new ErosConversationEngine(
      { ...config, debugBridge: undefined },
      { fetch: f.fetch },
    );
    expect((await engine.inspect(binding)).debug).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("makes one CAS patch with only editable raw axes and grades", async () => {
    const f = fixture();
    await f.engine.updateState({
      ...binding,
      axes,
      warmthGrade: 2,
      patienceGrade: 1,
      expectedRevision: "revision-1",
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...axes,
      warmthGrade: 2,
      patienceGrade: 1,
      expectedRevision: "revision-1",
    });
  });

  it("does not retry conflicts or an uncertain write", async () => {
    for (const response of [
      Response.json({ error: "conflict", detail: "private diagnostic" }, { status: 409 }),
      new Response("not JSON"),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      const engine = new ErosConversationEngine(config, { fetch });
      await expect(
        engine.updateState({
          ...binding,
          axes,
          warmthGrade: 2,
          patienceGrade: 1,
          expectedRevision: "revision-1",
        }),
      ).rejects.toThrow(/^Conversation engine: (conflict|uncertain)$/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
