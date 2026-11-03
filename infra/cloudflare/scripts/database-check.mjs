import { createRequire } from "node:module";

// Executed inside the fork's existing app image, using its already-pinned pg dependency.
const require = createRequire("/app/packages/db/package.json");
const { Client } = require("pg");
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15_000,
  statement_timeout: 15_000,
});
try {
  if (!process.env.DATABASE_URL) throw new Error("Missing runtime database");
  await client.connect();
  const {
    rows: [role],
  } = await client.query(`
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
      pg_has_role(current_user, 'rakazo_app', 'USAGE') AS runtime_member
    FROM pg_roles WHERE rolname=current_user
  `);
  if (
    !role?.runtime_member ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole
  )
    throw new Error("Unsafe runtime role");
  const {
    rows: [owner],
  } = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relrowsecurity
        AND pg_has_role(current_user, c.relowner, 'USAGE')
    ) AS owns_protected_tables
  `);
  if (owner.owns_protected_tables) throw new Error("Runtime role owns protected tables");
  console.log("Runtime database role passed privilege checks.");
} catch {
  console.error(
    "Runtime database preflight failed. Check TLS/connectivity, rakazo_app membership and ensure the login neither owns protected tables nor has elevated role privileges.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
