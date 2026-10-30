import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = /^\/v1\/sessions\/([0-9a-f-]{36})\/debug$/i;
const MAX_RESPONSE_BYTES = 128 * 1024;

export interface DebugSqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface DebugSqlPool {
  connect(): Promise<DebugSqlClient>;
}

export interface DebugBridgeConfig {
  jwtSecret: string;
  bridgeSecret: string;
  pool: DebugSqlPool;
  now?: () => number;
  generation?: () => Promise<unknown>;
}

interface Scope {
  userId: string;
  sessionId: string;
  instanceId: string;
  characterId: string;
}

type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "busy"
  | "unavailable";

class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError("invalid_request", 400);
  }
  return value as Record<string, unknown>;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(
  config: DebugBridgeConfig,
  authorization: string,
  secret: string,
  sessionId: string,
): Scope {
  const unauthorized = () => new BridgeError("unauthorized", 401);
  if (
    !equal(secret, config.bridgeSecret) ||
    authorization.length > 4096 ||
    !authorization.startsWith("Bearer ")
  ) {
    throw unauthorized();
  }
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    throw unauthorized();
  const [head, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", config.jwtSecret)
    .update(`${head}.${payload}`)
    .digest("base64url");
  if (!equal(expected, signature)) throw unauthorized();
  try {
    const header = record(JSON.parse(Buffer.from(head, "base64url").toString("utf8")));
    const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const now = Math.floor((config.now?.() ?? Date.now()) / 1000);
    if (
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      claims.aud !== "rakazo-eros-debug" ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      Number(claims.iat) > now + 5 ||
      Number(claims.iat) < now - 60 ||
      Number(claims.exp) <= now ||
      Number(claims.exp) <= Number(claims.iat) ||
      Number(claims.exp) > Number(claims.iat) + 60 ||
      Number(claims.exp) > now + 65
    )
      throw unauthorized();
    for (const key of ["sub", "session_id", "instance_id", "genome_id"]) {
      if (typeof claims[key] !== "string" || !UUID.test(claims[key] as string))
        throw unauthorized();
    }
    if (String(claims.session_id).toLowerCase() !== sessionId.toLowerCase()) throw unauthorized();
    return {
      userId: String(claims.sub).toLowerCase(),
      sessionId: sessionId.toLowerCase(),
      instanceId: String(claims.instance_id).toLowerCase(),
      characterId: String(claims.genome_id).toLowerCase(),
    };
  } catch {
    throw unauthorized();
  }
}

const AXES = ["trust", "intrigue", "intimacy", "tension"] as const;

function editValues(value: unknown) {
  const body = record(value);
  const keys = ["expectedRevision", ...AXES, "warmthGrade", "patienceGrade"];
  if (
    keys.some((key) => !(key in body)) ||
    Object.keys(body).some((key) => ![...keys, "elapsedHours"].includes(key))
  ) {
    throw new BridgeError("invalid_request", 400);
  }
  if (typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) {
    throw new BridgeError("invalid_request", 400);
  }
  for (const name of AXES) {
    if (
      typeof body[name] !== "number" ||
      !Number.isFinite(body[name]) ||
      Number(body[name]) < 0 ||
      Number(body[name]) > 1
    ) {
      throw new BridgeError("invalid_request", 400);
    }
  }
  for (const name of ["warmthGrade", "patienceGrade"]) {
    if (typeof body[name] !== "number" || ![1, 2, 3].includes(Number(body[name]))) {
      throw new BridgeError("invalid_request", 400);
    }
  }
  if (
    "elapsedHours" in body &&
    (typeof body.elapsedHours !== "number" ||
      !Number.isFinite(body.elapsedHours) ||
      body.elapsedHours < 0 ||
      body.elapsedHours > 720)
  )
    throw new BridgeError("invalid_request", 400);
  return body;
}

function revision(raw: string): string {
  // PostgreSQL's complete row text retains timestamp microseconds and every
  // pending/ghost/summary field. A summary-only write invalidates the CAS too.
  return createHash("sha256").update(raw).digest("hex");
}

function textValue(value: unknown, max: number, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new BridgeError("unavailable", 503);
  return value;
}

function timeState(row: Record<string, unknown>, affinity: Record<string, unknown> | null) {
  const currentTime = textValue(row.currentTime, 128, false)!;
  const current = new Date(currentTime);
  if (!Number.isFinite(current.getTime())) throw new BridgeError("unavailable", 503);
  // The native persona clock uses the valid genome zone, then request locale,
  // then Singapore. Rakazo sends no request timezone. Never edit shared genomes.
  let timezone = textValue(row.timezone, 80)?.trim() || "Asia/Singapore";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(current);
  } catch {
    timezone = "Asia/Singapore";
  }
  const elapsed = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const timestamp = Date.parse(textValue(value, 128, false)!);
    if (!Number.isFinite(timestamp)) throw new BridgeError("unavailable", 503);
    return Math.max(0, (current.getTime() - timestamp) / 3_600_000);
  };
  return {
    timezone,
    currentTime: current.toISOString(),
    localTime: new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(current),
    affinityElapsedHours: elapsed(affinity?.updated_at),
    feelingElapsedHours: affinity?.feeling_clause ? elapsed(affinity.feeling_clause_at) : null,
  };
}

function blockedReason(raw: string | null, settlement: DebugSettlement) {
  if (raw === null) return "missing_affinity";
  if (settlement.activeTurns) return "processing";
  if (settlement.recentMessages || settlement.recentAffinity) return "settling";
  if (settlement.hasLatestTurn && !settlement.latestAcknowledged && !settlement.latestFailed)
    return "unacknowledged_turn";
  return null;
}

function output(row: Record<string, unknown>, raw: string | null, settlement: DebugSettlement) {
  const affinity = raw === null ? null : record(JSON.parse(raw));
  if (affinity) {
    for (const name of AXES) {
      if (
        typeof affinity[name] !== "number" ||
        !Number.isFinite(affinity[name]) ||
        Number(affinity[name]) < 0 ||
        Number(affinity[name]) > 1
      ) {
        throw new BridgeError("unavailable", 503);
      }
    }
    if (
      ![1, 2, 3].includes(Number(affinity.warmth_grade)) ||
      ![1, 2, 3].includes(Number(affinity.patience_grade))
    ) {
      throw new BridgeError("unavailable", 503);
    }
  }
  return {
    sessionId: row.sessionId,
    instanceId: row.instanceId,
    characterId: row.characterId,
    characterName: textValue(row.characterName, 512, false),
    systemPrompt: textValue(row.systemPrompt, 64 * 1024, false),
    tipPersonality: textValue(row.tipPersonality, 8192),
    timezone: textValue(row.timezone, 80),
    feelingClause: affinity ? textValue(affinity.feeling_clause, 16 * 1024) : null,
    feelingClauseAt: affinity ? textValue(affinity.feeling_clause_at, 128) : null,
    warmthGrade: affinity ? Number(affinity.warmth_grade) : null,
    patienceGrade: affinity ? Number(affinity.patience_grade) : null,
    axes: affinity ? Object.fromEntries(AXES.map((name) => [name, affinity[name]])) : null,
    revision: raw === null ? null : revision(raw),
    editable: affinity !== null && !isDebugBusy(settlement),
    time: timeState(row, affinity),
    editBlockedReason: blockedReason(raw, settlement),
    retryAfterSeconds:
      settlement.recentMessages || settlement.recentAffinity ? settlement.retryAfterSeconds : null,
  };
}

const OWNED_STATE = `SELECT s.id AS "sessionId", s.instance_id AS "instanceId",
  i.genome_id AS "characterId", g.name AS "characterName", g.system_prompt AS "systemPrompt",
  g.tip_personality AS "tipPersonality", g.art_metadata->>'timezone' AS timezone,
  row_to_json(a)::text AS "affinityJson", clock_timestamp()::text AS "currentTime"
  FROM engine.chat_sessions s
  JOIN engine.persona_instances i ON i.id=s.instance_id
  JOIN engine.persona_genomes g ON g.id=i.genome_id
  LEFT JOIN engine.companion_affinity a ON a.session_id=s.id
  WHERE s.id=$1 AND s.user_id=$2 AND s.instance_id=$3 AND i.owner_uid=$2
    AND i.genome_id=$4 AND i.status='active' AND NOT s.archived AND s.channel='text'
    AND (a.id IS NULL OR (a.user_id=$2 AND a.instance_id=$3))`;

// A queue's done status only acknowledges generation. Require a separate
// affinity acknowledgement for the latest ordinary turn, or a linked terminal
// failure. Historical failed streams without a durable failure record must not
// block a newer settled turn forever. The latest unacknowledged turn stays
// blocked: elapsed time alone does not prove that detached processing stopped.
// The quiet period covers normal post-event summaries; feeling_clause_at also
// fences any older summary that returns late after an edit. No message content.
const BUSY = `WITH latest_turn AS (
  SELECT id FROM engine.chat_messages WHERE session_id=$1 AND role='user'
    AND channel IS DISTINCT FROM 'product_qa' ORDER BY sent_at DESC,id DESC LIMIT 1
) SELECT
  EXISTS (SELECT 1 FROM engine.chat_turn_queue q WHERE q.session_id=$1 AND q.status IN ('pending','claimed')) AS "activeTurns",
  EXISTS (SELECT 1 FROM engine.chat_messages m WHERE m.session_id=$1
    AND m.sent_at > clock_timestamp()-interval '30 seconds') AS "recentMessages",
  EXISTS (SELECT 1 FROM engine.companion_affinity a WHERE a.session_id=$1
    AND GREATEST(a.updated_at,a.feeling_clause_at) > clock_timestamp()-interval '30 seconds') AS "recentAffinity",
  GREATEST(0,LEAST(30,CEIL(EXTRACT(EPOCH FROM (
    GREATEST((SELECT max(sent_at) FROM engine.chat_messages WHERE session_id=$1),
      (SELECT GREATEST(updated_at,feeling_clause_at) FROM engine.companion_affinity WHERE session_id=$1))
    + interval '30 seconds' - clock_timestamp())))))::integer AS "retryAfterSeconds",
  EXISTS (SELECT 1 FROM latest_turn) AS "hasLatestTurn",
  EXISTS (SELECT 1 FROM latest_turn m JOIN engine.companion_affinity_events e ON e.user_message_id=m.id
    JOIN engine.companion_affinity a ON a.id=e.affinity_id WHERE a.session_id=$1) AS "latestAcknowledged",
  (EXISTS (SELECT 1 FROM latest_turn m JOIN engine.chat_turn_queue q ON q.user_message_id=m.id WHERE q.status='failed')
    OR EXISTS (SELECT 1 FROM latest_turn m JOIN engine.chat_messages failure ON failure.user_message_id=m.id
      WHERE failure.session_id=$1 AND failure.role='system_error')) AS "latestFailed"`;

export interface DebugSettlement {
  activeTurns: boolean;
  recentMessages: boolean;
  recentAffinity: boolean;
  hasLatestTurn: boolean;
  latestAcknowledged: boolean;
  latestFailed: boolean;
  retryAfterSeconds: number;
}

export function isDebugBusy(settlement: DebugSettlement): boolean {
  return (
    settlement.activeTurns ||
    settlement.recentMessages ||
    settlement.recentAffinity ||
    (settlement.hasLatestTurn && !settlement.latestAcknowledged && !settlement.latestFailed)
  );
}

function readSettlement(row: Record<string, unknown> | undefined): DebugSettlement {
  const keys = [
    "activeTurns",
    "recentMessages",
    "recentAffinity",
    "hasLatestTurn",
    "latestAcknowledged",
    "latestFailed",
  ];
  if (!row || keys.some((key) => typeof row[key] !== "boolean"))
    throw new BridgeError("unavailable", 503);
  if (
    !Number.isInteger(row.retryAfterSeconds) ||
    Number(row.retryAfterSeconds) < 0 ||
    Number(row.retryAfterSeconds) > 30
  )
    throw new BridgeError("unavailable", 503);
  return row as unknown as DebugSettlement;
}

export interface DebugBridgeRequest {
  method: string;
  path: string;
  authorization: string;
  secret: string;
  body?: unknown;
}

/** Fixed DB protocol for the optional, separately credentialed Eros sidecar. */
export function createDebugBridge(config: DebugBridgeConfig) {
  if (config.jwtSecret.length < 32 || config.bridgeSecret.length < 32)
    throw new Error("Invalid debug bridge configuration");
  return async (request: DebugBridgeRequest): Promise<{ status: number; body: unknown }> => {
    let client: DebugSqlClient | undefined;
    let transaction = false;
    try {
      const route = ROUTE.exec(request.path);
      if (!route || !UUID.test(route[1] ?? "") || !["GET", "PATCH"].includes(request.method))
        throw new BridgeError("not_found", 404);
      const scope = authenticate(config, request.authorization, request.secret, route[1] as string);
      const edits = request.method === "PATCH" ? editValues(request.body) : null;
      client = await config.pool.connect();
      await client.query("BEGIN");
      transaction = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query(
        `SELECT set_config('rakazo_debug.user_id',$1,true), set_config('rakazo_debug.session_id',$2,true),
        set_config('rakazo_debug.instance_id',$3,true), set_config('rakazo_debug.genome_id',$4,true)`,
        [scope.userId, scope.sessionId, scope.instanceId, scope.characterId],
      );
      const args = [scope.sessionId, scope.userId, scope.instanceId, scope.characterId];
      const row = (await client.query(OWNED_STATE, args)).rows[0];
      if (!row) throw new BridgeError("not_found", 404);
      let raw = row.affinityJson === null ? null : textValue(row.affinityJson, 64 * 1024, false);
      if (edits) {
        const locked = (
          await client.query(
            `SELECT row_to_json(a)::text AS "affinityJson"
          FROM engine.companion_affinity a WHERE a.session_id=$1 AND a.user_id=$2 AND a.instance_id=$3 FOR UPDATE OF a`,
            args.slice(0, 3),
          )
        ).rows[0];
        if (!locked) throw new BridgeError("conflict", 409);
        raw = textValue(locked.affinityJson, 64 * 1024, false);
        if (raw === null || !equal(revision(raw), String(edits.expectedRevision)))
          throw new BridgeError("conflict", 409);
      }
      let settlement = readSettlement((await client.query(BUSY, [scope.sessionId])).rows[0]);
      if (edits) {
        if (isDebugBusy(settlement)) throw new BridgeError("busy", 409);
        const changed = (
          await client.query(
            `UPDATE engine.companion_affinity a SET
          trust=$4, intrigue=$5, intimacy=$6, tension=$7, warmth_grade=$8, patience_grade=$9,
          feeling_clause=NULL, feeling_clause_at=clock_timestamp(),
          updated_at=clock_timestamp()-make_interval(secs => $10::double precision * 3600)
          WHERE a.session_id=$1 AND a.user_id=$2 AND a.instance_id=$3
          RETURNING row_to_json(a)::text AS "affinityJson", clock_timestamp()::text AS "currentTime"`,
            [
              ...args.slice(0, 3),
              ...AXES.map((name) => edits[name]),
              edits.warmthGrade,
              edits.patienceGrade,
              edits.elapsedHours ?? 0,
            ],
          )
        ).rows[0];
        if (!changed) throw new BridgeError("conflict", 409);
        raw = textValue(changed.affinityJson, 64 * 1024, false);
        row.currentTime = changed.currentTime;
        // feeling_clause_at is a real-time fence, even when updated_at is aged.
        // Native summaries derived before this edit cannot overwrite it.
        settlement = { ...settlement, recentAffinity: true, retryAfterSeconds: 30 };
      }
      const result = {
        ...output(row, raw, settlement),
        ...(config.generation ? { generation: await config.generation() } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES)
        throw new BridgeError("unavailable", 503);
      await client.query("COMMIT");
      transaction = false;
      return { status: 200, body: result };
    } catch (error) {
      if (transaction) await client?.query("ROLLBACK").catch(() => {});
      const failure = error instanceof BridgeError ? error : new BridgeError("unavailable", 503);
      return { status: failure.status, body: { error: failure.code } };
    } finally {
      client?.release();
    }
  };
}

export function createDebugBridgeHandler(config: DebugBridgeConfig) {
  const dispatch = createDebugBridge(config);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    try {
      // No CORS: only the Rakazo backend calls this listener.
      if (req.headers.origin) return reply(401, { error: "unauthorized" });
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 4096) return reply(400, { error: "invalid_request" });
        chunks.push(data);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (
        req.method === "PATCH" &&
        req.headers["content-type"]?.split(";")[0] !== "application/json"
      )
        return reply(400, { error: "invalid_request" });
      if (req.method === "GET" && raw) return reply(400, { error: "invalid_request" });
      const result = await dispatch({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        secret:
          typeof req.headers["x-debug-secret"] === "string" ? req.headers["x-debug-secret"] : "",
        body: raw ? JSON.parse(raw) : undefined,
      });
      reply(result.status, result.body);
    } catch {
      reply(400, { error: "invalid_request" });
    }
  };
}
