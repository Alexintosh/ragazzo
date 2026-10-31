import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFERRED_MIGRATION_MARKER,
  deployMigrations,
  heldBackMigrations,
} from "./deferred-migrations.js";

// Creating schemas and running migrations need the owner login.
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));

dbTests("deferred migrations", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const table = `deferred_probe_${stamp}`;
  const added = `29990101000000_add_${stamp}`;
  const dropped = `29990101000001_drop_${stamp}`;
  const freshSchema = `deferred_fresh_${stamp}`;
  const dir = mkdtempSync(path.join(tmpdir(), "deferred-migrations-"));
  let client: Client;

  function migration(name: string, sql: string) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "migration.sql"), sql);
  }

  async function columns() {
    const { rows } = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY 1",
      [table],
    );
    return rows.map((row) => row.column_name);
  }

  beforeAll(async () => {
    cpSync(path.join(dbPackageDir, "prisma/migrations"), dir, { recursive: true });
    migration(added, `CREATE TABLE "${table}" (id INT, gone INT);\n`);
    migration(dropped, `${DEFERRED_MIGRATION_MARKER}\nALTER TABLE "${table}" DROP COLUMN gone;\n`);
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${freshSchema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.query("DELETE FROM _prisma_migrations WHERE migration_name = ANY($1)", [
      [added, dropped],
    ]);
    await client.query('DELETE FROM "_deferred_migrations" WHERE name = $1', [dropped]);
    await client.query(`DROP SCHEMA "${freshSchema}"`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds nothing back on a database with no migrations applied", async () => {
    const fresh = new URL(databaseUrl!);
    fresh.searchParams.set("options", `-c search_path=${freshSchema}`);
    await expect(heldBackMigrations(fresh.toString(), dir)).resolves.toEqual([]);
  });

  it("applies ordinary migrations at once and a deferred drop on the next run", async () => {
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns()).toEqual(["gone", "id"]);
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns()).toEqual(["id"]);
  });
});

dbTests("previous bot release migration compatibility", () => {
  it("keeps the previous bot columns readable through the first deployment", async () => {
    const schema = `bot_predecessor_${process.pid}_${Date.now()}`;
    const dir = mkdtempSync(path.join(tmpdir(), "bot-predecessor-"));
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set("schema", schema);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    try {
      const predecessor = "20261001000000_previous_bot_release";
      mkdirSync(path.join(dir, predecessor));
      writeFileSync(
        path.join(dir, predecessor, "migration.sql"),
        `
        CREATE TABLE bots (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          "selfUpdateInstructions" BOOLEAN NOT NULL DEFAULT false
        );
        CREATE TABLE referrals ("rewardKind" TEXT, "declinedAt" TIMESTAMPTZ);
      `,
      );
      await deployMigrations({
        migrationUrl: isolated.toString(),
        dbPackageDir,
        migrationsDir: dir,
      });
      const drop = "20261103120000_drop_dead_bot_and_referral_columns";
      mkdirSync(path.join(dir, drop));
      writeFileSync(
        path.join(dir, drop, "migration.sql"),
        readFileSync(path.join(dbPackageDir, "prisma/migrations", drop, "migration.sql"), "utf8"),
      );

      await deployMigrations({
        migrationUrl: isolated.toString(),
        dbPackageDir,
        migrationsDir: dir,
      });
      // The previous release still supplies and reads both removed Prisma fields.
      await client.query(`INSERT INTO "${schema}".bots (id, name, title, "selfUpdateInstructions")
        VALUES ('old-release', 'Existing bot', 'Previous title', true)`);
      // The new release omits them, so the predecessor defaults must remain usable too.
      await client.query(
        `INSERT INTO "${schema}".bots (id, name) VALUES ('new-release', 'New bot')`,
      );
      const { rows } = await client.query(`SELECT title, "selfUpdateInstructions"
        FROM "${schema}".bots ORDER BY id`);
      expect(rows).toEqual([
        { title: "", selfUpdateInstructions: false },
        { title: "Previous title", selfUpdateInstructions: true },
      ]);

      await deployMigrations({
        migrationUrl: isolated.toString(),
        dbPackageDir,
        migrationsDir: dir,
      });
      const { rows: columns } = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'bots' ORDER BY 1",
        [schema],
      );
      expect(columns.map((row) => row.column_name)).toEqual(["id", "name"]);
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
