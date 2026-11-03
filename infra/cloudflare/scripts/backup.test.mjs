import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("failed object snapshot resumes every stopped origin and never publishes a completion marker", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rakazo-backup-test-"));
  try {
    const events = path.join(temporary, "events.jsonl");
    const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const tool = process.argv[1].split('/').pop();
const args = process.argv.slice(2);
const record = (input = '') => fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify({ tool, args, input }) + '\\n');
if (args.includes('--version')) { record(); process.exit(0); }
if (tool === 'ssh') {
  let input = ''; process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => record(input));
} else if (tool === 'pg_dump') {
  record(); process.stdout.write('fixture-private-database');
} else if (tool === 'age') {
  process.stdin.resume(); process.stdin.on('end', () => {
    record(); fs.writeFileSync(args[args.indexOf('--output') + 1], 'fixture-ciphertext');
  });
} else { record(); if (args.includes('sync')) process.exit(13); }
`;
    for (const command of ["ssh", "age", "pg_dump", "aws"])
      writeFileSync(path.join(temporary, command), shim, { mode: 0o700 });
    const writeJson = (name, value) => {
      const file = path.join(temporary, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const credentials = {
      DATABASE_BACKUP_URL:
        "postgresql://owner:fixture-password@db.example.com/db?sslmode=verify-full",
      AWS_ACCESS_KEY_ID: "fixture-access",
      AWS_SECRET_ACCESS_KEY: "fixture-secret",
    };
    const foundation = writeJson("foundation.json", {
      account_id: "1".repeat(32),
      endpoint: `https://${"1".repeat(32)}.r2.cloudflarestorage.com`,
      bucket: "fixture-data",
      backup_bucket: "fixture-backups",
    });
    const inventory = writeJson("hosts.json", ["root@192.0.2.1", "root@192.0.2.2"]);
    let failure;
    try {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./backup.mjs", import.meta.url)),
          foundation,
          inventory,
          writeJson("credentials.json", credentials),
          "age1fixture",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, TEST_EVENTS: events },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const calls = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.tool === "ssh" && call.input.includes("stop cloudflared")).length,
      2,
    );
    assert.equal(
      calls.filter((call) => call.tool === "ssh" && call.input.includes("up -d --wait")).length,
      2,
    );
    assert.ok(!calls.some((call) => call.args.some((arg) => arg.endsWith("complete.json"))));
    const visible = `${failure.stdout}${failure.stderr}`;
    for (const value of [...Object.values(credentials), "fixture-private-database"])
      assert.ok(!visible.includes(value));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
