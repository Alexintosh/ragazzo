import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDb, createPool } from "./client.js";
import { isRoleplayEnabled } from "./roleplay-settings.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

postgres("account roleplay preference (PostgreSQL)", () => {
  it("preserves existing character owners and defaults other accounts to disabled", async () => {
    const pool = createPool(databaseUrl!);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('CREATE TEMP TABLE "user" (id TEXT PRIMARY KEY)');
      await client.query('CREATE TEMP TABLE bots ("userId" TEXT, "botKind" TEXT)');
      await client.query(
        "INSERT INTO \"user\" VALUES ('existing-rp'), ('assistant-owner'), ('empty')",
      );
      await client.query(
        "INSERT INTO bots VALUES ('existing-rp', 'roleplay'), ('assistant-owner', 'assistant')",
      );
      await client.query(
        await readFile(
          new URL(
            "../prisma/migrations/20261101140000_account_roleplay_preference/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await client.query("INSERT INTO \"user\" (id) VALUES ('new-account')");
      expect(
        (await client.query('SELECT id, "roleplayEnabled" FROM "user" ORDER BY id')).rows,
      ).toEqual([
        { id: "assistant-owner", roleplayEnabled: false },
        { id: "empty", roleplayEnabled: false },
        { id: "existing-rp", roleplayEnabled: true },
        { id: "new-account", roleplayEnabled: false },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });

  it("persists across new clients and updates live without affecting another account", async () => {
    const owner = `rp-settings-${randomUUID()}`;
    const other = `rp-settings-${randomUUID()}`;
    const writer = createDb(databaseUrl!);
    let reader = createDb(databaseUrl!);
    const prisma = asSystem(writer.prisma);
    try {
      await prisma.user.createMany({
        data: [owner, other].map((id) => ({ id, name: "Test", email: `${id}@example.test` })),
      });
      expect(await isRoleplayEnabled(reader.prisma, owner)).toBe(false);
      await prisma.user.update({ where: { id: owner }, data: { roleplayEnabled: true } });
      expect(await isRoleplayEnabled(reader.prisma, owner)).toBe(true);
      expect(await isRoleplayEnabled(reader.prisma, other)).toBe(false);
      await reader.prisma.$disconnect();
      await reader.pool.end();
      reader = createDb(databaseUrl!);
      expect(await isRoleplayEnabled(reader.prisma, owner)).toBe(true);
      await prisma.user.update({ where: { id: owner }, data: { roleplayEnabled: false } });
      expect(await isRoleplayEnabled(reader.prisma, owner)).toBe(false);
      expect(await isRoleplayEnabled(reader.prisma, "missing-account")).toBe(false);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
      await Promise.all([reader.prisma.$disconnect(), writer.prisma.$disconnect()]);
      await Promise.all([reader.pool.end(), writer.pool.end()]);
    }
  });
});
