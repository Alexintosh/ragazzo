import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DebugBridgeRequest, DebugSettlement, DebugSqlClient } from "./debug-bridge.js";
import { createDebugBridge, createDebugBridgeHandler, isDebugBusy } from "./debug-bridge.js";

const user = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";
const instance = "33333333-3333-4333-8333-333333333333";
const character = "44444444-4444-4444-8444-444444444444";
const jwtSecret = "test-jwt-secret-".repeat(4);
const bridgeSecret = "test-debug-secret-".repeat(4);
const now = 1800000000000;
const databaseTime = "2026-01-02T00:00:00.000Z";

function token(overrides: Record<string, unknown> = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: user,
      session_id: session,
      instance_id: instance,
      genome_id: character,
      aud: "rakazo-eros-debug",
      iat: now / 1000,
      exp: now / 1000 + 30,
      ...overrides,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", jwtSecret)
    .update(`${head}.${payload}`)
    .digest("base64url");
  return `Bearer ${head}.${payload}.${signature}`;
}

function request(overrides: Partial<DebugBridgeRequest> = {}): DebugBridgeRequest {
  return {
    method: "GET",
    path: `/v1/sessions/${session}/debug`,
    authorization: token(),
    secret: bridgeSecret,
    ...overrides,
  };
}

function setup(
  options: {
    owned?: boolean;
    busy?: boolean;
    missing?: boolean;
    fail?: boolean;
    timezone?: string | null;
  } = {},
) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const settlement: DebugSettlement = {
    activeTurns: options.busy ?? false,
    recentMessages: false,
    recentAffinity: false,
    hasLatestTurn: false,
    latestAcknowledged: false,
    latestFailed: false,
    retryAfterSeconds: 0,
  };
  let affinity = {
    trust: 0.2,
    intrigue: 0.3,
    intimacy: 0.4,
    tension: 0.5,
    warmth_grade: 2,
    patience_grade: 3,
    feeling_clause: "An example feeling.",
    feeling_clause_at: "2026-01-01T00:00:00.123456+00:00",
    updated_at: "2026-01-01T00:00:00.123456+00:00",
    pending_deltas: { trust: 0.01 },
    ghost_streak: 2,
    total_ghosts: 4,
  };
  const client: DebugSqlClient = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (options.fail) throw new Error("secret database credential and private prompt");
      if (sql.includes('g.name AS "characterName"'))
        return {
          rows:
            options.owned === false || args.join() !== [session, user, instance, character].join()
              ? []
              : [
                  {
                    sessionId: session,
                    instanceId: instance,
                    characterId: character,
                    characterName: "Example",
                    systemPrompt: "Example persona.",
                    tipPersonality: null,
                    timezone: options.timezone === undefined ? "Europe/Lisbon" : options.timezone,
                    currentTime: databaseTime,
                    affinityJson: options.missing ? null : JSON.stringify(affinity),
                  },
                ],
        };
      if (sql.includes("FOR UPDATE"))
        return { rows: options.missing ? [] : [{ affinityJson: JSON.stringify(affinity) }] };
      if (sql.includes('AS "activeTurns"')) return { rows: [{ ...settlement }] };
      if (sql.startsWith("UPDATE engine.companion_affinity")) {
        affinity = {
          ...affinity,
          trust: args[3] as number,
          intrigue: args[4] as number,
          intimacy: args[5] as number,
          tension: args[6] as number,
          warmth_grade: args[7] as number,
          patience_grade: args[8] as number,
          feeling_clause: null as unknown as string,
          feeling_clause_at: "2026-01-02T00:00:00.000001+00:00",
          updated_at: new Date(
            Date.parse(databaseTime) - Number(args[9]) * 3_600_000,
          ).toISOString(),
        };
        settlement.recentAffinity = true;
        settlement.retryAfterSeconds = 30;
        return { rows: [{ affinityJson: JSON.stringify(affinity), currentTime: databaseTime }] };
      }
      return { rows: [] };
    },
    release() {
      calls.push({ sql: "release", args: [] });
    },
  };
  let connections = 0;
  const dispatch = createDebugBridge({
    jwtSecret,
    bridgeSecret,
    now: () => now,
    pool: {
      async connect() {
        connections++;
        return client;
      },
    },
  });
  return {
    dispatch,
    calls,
    affinity: () => affinity,
    connections: () => connections,
    settlement,
    changeSummary() {
      affinity.feeling_clause = "A newer summary.";
    },
  };
}

async function patch(fixture: ReturnType<typeof setup>, changes: Record<string, unknown> = {}) {
  const read = await fixture.dispatch(request());
  const state = read.body as { revision: string };
  return fixture.dispatch(
    request({
      method: "PATCH",
      body: {
        expectedRevision: state.revision,
        trust: 0.9,
        intrigue: 0.8,
        intimacy: 0.7,
        tension: 0.6,
        warmthGrade: 1,
        patienceGrade: 2,
        ...changes,
      },
    }),
  );
}

describe("optional Eros debug bridge", () => {
  it("bounds HTTP input and refuses browser-origin requests before accessing the database", async () => {
    let connections = 0;
    const handler = createDebugBridgeHandler({
      jwtSecret,
      bridgeSecret,
      pool: {
        async connect(): Promise<DebugSqlClient> {
          connections++;
          throw new Error("Unexpected database request");
        },
      },
    });
    for (const input of [
      { headers: { origin: "http://localhost" }, method: "GET", raw: "", status: 401 },
      { headers: {}, method: "PATCH", raw: "x".repeat(4097), status: 400 },
      { headers: {}, method: "GET", raw: "{}", status: 400 },
      { headers: { "content-type": "text/plain" }, method: "PATCH", raw: "{}", status: 400 },
      {
        headers: { "content-type": "application/json" },
        method: "PATCH",
        raw: "{broken",
        status: 400,
      },
    ]) {
      const incoming = Object.assign(Readable.from([Buffer.from(input.raw)]), {
        headers: input.headers,
        method: input.method,
        url: `/v1/sessions/${session}/debug`,
      }) as unknown as IncomingMessage;
      let status = 0;
      let result = "";
      const response = {
        writeHead(code: number) {
          status = code;
        },
        end(body: string) {
          result = body;
        },
      } as unknown as ServerResponse;
      await handler(incoming, response);
      expect(status).toBe(input.status);
      expect(result).toMatch(/unauthorized|invalid_request/);
    }
    expect(connections).toBe(0);
  });

  it("authenticates scoped short-lived tokens before opening the database", async () => {
    const fixture = setup();
    for (const bad of [
      request({ secret: "wrong" }),
      request({ authorization: `${token()}x` }),
      request({ authorization: token({ exp: now / 1000 - 1 }) }),
      request({ authorization: token({ exp: now / 1000 + 3600 }) }),
      request({ authorization: token({ aud: "eros-engine" }) }),
      request({ authorization: token({ session_id: user }) }),
      request({ authorization: token({ instance_id: "invalid" }) }),
    ]) {
      expect(await fixture.dispatch(bad)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(fixture.connections()).toBe(0);
  });

  it("checks the DB ownership/genome binding instead of trusting signed IDs alone", async () => {
    const fixture = setup();
    expect(await fixture.dispatch(request({ authorization: token({ sub: character }) }))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(
      fixture.calls.find((call) => call.sql.includes('g.name AS "characterName"'))?.args,
    ).toEqual([session, character, instance, character]);
    expect(fixture.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(await setup({ owned: false }).dispatch(request())).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  it("projects actual private-session state without leaking arbitrary metadata or transcript fields", async () => {
    const fixture = setup();
    const response = await fixture.dispatch(request());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      characterName: "Example",
      systemPrompt: "Example persona.",
      feelingClause: "An example feeling.",
      warmthGrade: 2,
      patienceGrade: 3,
      axes: { trust: 0.2, intrigue: 0.3, intimacy: 0.4, tension: 0.5 },
      editable: true,
    });
    expect(response.body).not.toHaveProperty("pending_deltas");
    expect(response.body).not.toHaveProperty("artMetadata");
    expect(JSON.stringify(fixture.calls)).not.toContain("m.content");
    expect(fixture.calls.at(-2)?.sql).toBe("COMMIT");
  });

  it("represents an uninitialized relationship without writing one", async () => {
    const fixture = setup({ missing: true });
    expect((await fixture.dispatch(request())).body).toMatchObject({
      revision: null,
      axes: null,
      warmthGrade: null,
      patienceGrade: null,
      feelingClause: null,
      feelingClauseAt: null,
      editable: false,
      editBlockedReason: "missing_affinity",
      systemPrompt: "Example persona.",
    });
    expect(fixture.calls.some((call) => /INSERT|UPDATE/.test(call.sql))).toBe(false);
  });

  it("reports the native persona clock and elapsed state time from the database clock", async () => {
    const fixture = setup();
    const state = (await fixture.dispatch(request())).body;
    expect(state).toMatchObject({
      time: {
        timezone: "Europe/Lisbon",
        currentTime: databaseTime,
        localTime: "2026-01-02 00:00:00",
        affinityElapsedHours: expect.closeTo(24, 3),
        feelingElapsedHours: expect.closeTo(24, 3),
      },
      editBlockedReason: null,
      retryAfterSeconds: null,
    });
  });

  it("uses the native Singapore fallback for missing or invalid persona zones", async () => {
    for (const timezone of [null, "", "Not/AZone"]) {
      expect((await setup({ timezone }).dispatch(request())).body).toMatchObject({
        time: { timezone: "Asia/Singapore", localTime: "2026-01-02 08:00:00" },
      });
    }
  });

  it("reports why edits are blocked without withholding the editable state snapshot", async () => {
    const fixture = setup();
    for (const [field, reason] of [
      ["activeTurns", "processing"],
      ["recentMessages", "settling"],
      ["hasLatestTurn", "unacknowledged_turn"],
    ] as const) {
      fixture.settlement[field] = true;
      expect((await fixture.dispatch(request())).body).toMatchObject({
        editable: false,
        editBlockedReason: reason,
        axes: { trust: 0.2 },
        revision: expect.any(String),
      });
      fixture.settlement[field] = false;
    }
  });

  it("ages only the session affinity while preserving the real-time feeling fence and quiet guard", async () => {
    const fixture = setup();
    const changed = await patch(fixture, { elapsedHours: 48.5 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      feelingClause: null,
      time: { affinityElapsedHours: 48.5, feelingElapsedHours: null },
      editable: false,
      editBlockedReason: "settling",
      retryAfterSeconds: 30,
    });
    const update = fixture.calls.find((call) =>
      call.sql.startsWith("UPDATE engine.companion_affinity"),
    );
    expect(update?.args[9]).toBe(48.5);
    expect(update?.sql).toContain("feeling_clause_at=clock_timestamp()");
    expect(update?.sql).toContain("updated_at=clock_timestamp()-make_interval");
    expect(
      fixture.calls.some((call) =>
        /UPDATE engine\.(persona_genomes|persona_instances)/.test(call.sql),
      ),
    ).toBe(false);
    // Backdated affinity is never evidence that new native work has settled.
    fixture.settlement.recentAffinity = false;
    for (const field of ["recentMessages", "activeTurns", "hasLatestTurn"] as const) {
      fixture.settlement[field] = true;
      expect(await patch(fixture, { elapsedHours: 720 })).toEqual({
        status: 409,
        body: { error: "busy" },
      });
      fixture.settlement[field] = false;
    }
    const busyQuery = fixture.calls.find((call) => call.sql.includes('AS "activeTurns"'))?.sql;
    expect(busyQuery).toContain("GREATEST(a.updated_at,a.feeling_clause_at)");
  });

  it("rejects invalid edits, unknown fields, and grades outside 1–3", async () => {
    for (const changes of [
      { trust: -0.1 },
      { tension: 1.1 },
      { intrigue: Number.NaN },
      { intimacy: true },
      { warmthGrade: 0 },
      { patienceGrade: 1.5 },
      { unexpected: "sql" },
      { expectedRevision: "bad" },
      { elapsedHours: -1 },
      { elapsedHours: 721 },
      { elapsedHours: Number.NaN },
      { elapsedHours: "12" },
      { timezone: "UTC" },
    ]) {
      const fixture = setup();
      expect(await patch(fixture, changes)).toEqual({
        status: 400,
        body: { error: "invalid_request" },
      });
      expect(fixture.connections()).toBe(1); // Only the initial read.
    }
  });

  it("locks and changes only the requested axes, grades and stale feeling state", async () => {
    const fixture = setup();
    const before = (await fixture.dispatch(request())).body as { revision: string };
    const response = await patch(fixture);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      axes: { trust: 0.9, intrigue: 0.8, intimacy: 0.7, tension: 0.6 },
      warmthGrade: 1,
      patienceGrade: 2,
      feelingClause: null,
      editable: false,
    });
    expect((response.body as { revision: string }).revision).not.toBe(before.revision);
    const update = fixture.calls.find((call) =>
      call.sql.startsWith("UPDATE engine.companion_affinity"),
    );
    expect(fixture.calls.findIndex((call) => call.sql.includes("FOR UPDATE"))).toBeLessThan(
      fixture.calls.indexOf(update as (typeof fixture.calls)[number]),
    );
    expect(update?.sql).not.toMatch(
      /pending_deltas\s*=|ghost_streak\s*=|total_ghosts\s*=|last_ghost_at\s*=/,
    );
    expect(fixture.affinity()).toMatchObject({
      pending_deltas: { trust: 0.01 },
      ghost_streak: 2,
      total_ghosts: 4,
    });
  });

  it("rejects a stale revision even when only the saved summary changed", async () => {
    const fixture = setup();
    const state = (await fixture.dispatch(request())).body as { revision: string };
    fixture.changeSummary();
    expect(await patch(fixture, { expectedRevision: state.revision })).toEqual({
      status: 409,
      body: { error: "conflict" },
    });
    expect(
      fixture.calls.some((call) => call.sql.startsWith("UPDATE engine.companion_affinity")),
    ).toBe(false);
  });

  it("rejects unsettled turns independently of the row revision", async () => {
    const fixture = setup({ busy: true });
    expect((await fixture.dispatch(request())).body).toMatchObject({ editable: false });
    expect(await patch(fixture)).toEqual({ status: 409, body: { error: "busy" } });
    expect(
      fixture.calls.some((call) => call.sql.startsWith("UPDATE engine.companion_affinity")),
    ).toBe(false);
    const busyQuery = fixture.calls.find((call) => call.sql.includes('AS "activeTurns"'))?.sql;
    expect(busyQuery).toContain("'pending','claimed'");
    expect(busyQuery).toContain("e.user_message_id=m.id");
    expect(busyQuery).toContain("interval '30 seconds'");
  });

  it("lets a later acknowledged turn recover editing after an older unrecorded stream failure", async () => {
    const fixture = setup();
    // A failed stream may leave a user row without a queue failure or an
    // affinity event. While it is the latest turn, remain conservative.
    fixture.settlement.hasLatestTurn = true;
    expect(await patch(fixture)).toEqual({ status: 409, body: { error: "busy" } });
    // A subsequent ordinary turn has now persisted its affinity event and
    // passed the quiet period. The old missing event no longer blocks it.
    fixture.settlement.latestAcknowledged = true;
    expect((await patch(fixture)).status).toBe(200);
    const query = fixture.calls.find((call) => call.sql.includes('AS "activeTurns"'))?.sql;
    expect(query).toContain("ORDER BY sent_at DESC,id DESC LIMIT 1");
  });

  it("requires an affinity acknowledgement or linked terminal failure for the latest ordinary turn", () => {
    const base: DebugSettlement = {
      activeTurns: false,
      recentMessages: false,
      recentAffinity: false,
      hasLatestTurn: true,
      latestAcknowledged: false,
      latestFailed: false,
      retryAfterSeconds: 0,
    };
    expect(isDebugBusy(base)).toBe(true);
    expect(isDebugBusy({ ...base, latestFailed: true })).toBe(false);
    expect(isDebugBusy({ ...base, latestAcknowledged: true })).toBe(false);
    expect(isDebugBusy({ ...base, latestAcknowledged: true, activeTurns: true })).toBe(true);
    expect(isDebugBusy({ ...base, latestFailed: true, recentMessages: true })).toBe(true);
    expect(isDebugBusy({ ...base, latestAcknowledged: true, recentAffinity: true })).toBe(true);
  });

  it("returns fixed errors without database details", async () => {
    expect(await setup({ fail: true }).dispatch(request())).toEqual({
      status: 503,
      body: { error: "unavailable" },
    });
    expect(await setup().dispatch(request({ path: "/arbitrary/sql" }))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });
});
