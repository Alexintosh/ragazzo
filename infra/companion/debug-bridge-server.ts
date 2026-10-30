// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This standalone sidecar runs outside Turborepo tasks.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import pg from "pg";
import { createDebugBridgeHandler } from "./debug-bridge.js";

const jwtSecret = process.env.DEBUG_JWT_SECRET ?? "";
const bridgeSecret = process.env.DEBUG_BRIDGE_SECRET ?? "";
const connectionString = process.env.DATABASE_URL;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8081);
if (
  !connectionString ||
  jwtSecret.length < 32 ||
  bridgeSecret.length < 32 ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !["127.0.0.1", "0.0.0.0", "::1"].includes(host)
) {
  throw new Error("Invalid debug bridge configuration");
}

const pool = new pg.Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
});
// Database errors never include connection strings, SQL, prompts or headers in logs.
pool.on("error", () => {});
const execute = promisify(execFile);
const generation =
  process.env.MODEL_CONFIG_PATH && process.env.MODEL_SUMMARY_SCRIPT
    ? async () => {
        try {
          const result = await execute(
            "python3",
            [process.env.MODEL_SUMMARY_SCRIPT!, process.env.MODEL_CONFIG_PATH!],
            { timeout: 3000, maxBuffer: 32768 },
          );
          return JSON.parse(result.stdout) as unknown;
        } catch {
          return null;
        }
      }
    : undefined;
const server = createServer(
  createDebugBridgeHandler({ jwtSecret, bridgeSecret, pool, generation }),
);
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 32;
server.listen(port, host);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
