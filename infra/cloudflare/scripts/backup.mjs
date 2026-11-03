import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { databaseUrl, envObject, validateHosts } from "./config.mjs";
import { run, sshOptions } from "./process.mjs";

process.umask(0o077);
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Could not read backup configuration JSON");
  }
};

// pg_dump plaintext travels only through a pipe into age, never to disk or stdout.
async function encryptedDump(connection, recipient, output) {
  const url = databaseUrl(connection, "DATABASE_BACKUP_URL");
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: "verify-full",
    PGCONNECT_TIMEOUT: "15",
  };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.PGOPTIONS;
  await new Promise((resolve, reject) => {
    const dump = spawn("pg_dump", ["--format=custom", "--no-password"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const age = spawn("age", ["--encrypt", "--recipient", recipient, "--output", output], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const fail = () => {
      dump.kill();
      age.kill();
      reject(
        new Error(
          "Encrypted database dump failed; check pg_dump version, TLS, owner permissions and age recipient",
        ),
      );
    };
    dump.on("error", fail);
    age.on("error", fail);
    dump.stdout.on("error", fail);
    age.stdin.on("error", fail);
    dump.stdout.pipe(age.stdin);
    let finished = 0;
    for (const child of [dump, age])
      child.on("close", (code) => {
        if (code !== 0) fail();
        else if (++finished === 2) resolve();
      });
  });
}

async function main() {
  const [foundation, inventory, credentials, recipient] = process.argv.slice(2);
  if (!recipient || !/^age1[0-9a-z]+$/.test(recipient))
    throw new Error(
      "backup.mjs <terraform-output.json> <all-hosts.json> <backup-secrets.json> <age-public-recipient>",
    );
  const deployment = await readJson(foundation);
  const hosts = validateHosts(await readJson(inventory));
  const secrets = envObject(await readJson(credentials));
  databaseUrl(secrets.DATABASE_BACKUP_URL, "DATABASE_BACKUP_URL");
  if (
    !/^[a-f0-9]{32}$/.test(deployment.account_id) ||
    deployment.endpoint !== `https://${deployment.account_id}.r2.cloudflarestorage.com` ||
    !/^[a-z0-9-]+$/.test(deployment.bucket) ||
    !/^[a-z0-9-]+$/.test(deployment.backup_bucket) ||
    deployment.bucket === deployment.backup_bucket
  )
    throw new Error("Invalid backup bucket configuration");
  if (!secrets.AWS_ACCESS_KEY_ID || !secrets.AWS_SECRET_ACCESS_KEY)
    throw new Error("Supply separate backup credentials with data read and backup write access");
  for (const [tool, args] of [
    ["pg_dump", ["--version"]],
    ["age", ["--version"]],
    ["aws", ["--version"]],
  ])
    await run(tool, args);
  const awsEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: secrets.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: secrets.AWS_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
    AWS_PAGER: "",
  };
  delete awsEnv.AWS_SESSION_TOKEN;
  const snapshot = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "rakazo-backup-"));
  const attempted = [];
  const errors = [];
  const prefix = `s3://${deployment.backup_bucket}/snapshots/${snapshot}`;
  try {
    for (const host of hosts) {
      attempted.push(host);
      await run("ssh", [...sshOptions, host, `bash -s -- ${snapshot}`], {
        input: `set -euo pipefail
exec 9>/opt/rakazo/deploy.lock
flock -n 9
(set -o noclobber; printf '%s' "$1" > /opt/rakazo/maintenance)
cd /opt/rakazo/current
docker compose --project-name rakazo --env-file .env -f compose.yml stop cloudflared web api worker
`,
      });
    }
    const dump = path.join(temporary, "database.dump.age");
    await encryptedDump(secrets.DATABASE_BACKUP_URL, recipient, dump);
    const aws = (args) =>
      run("aws", ["--endpoint-url", deployment.endpoint, ...args], { env: awsEnv });
    await aws([
      "s3",
      "sync",
      `s3://${deployment.bucket}`,
      `${prefix}/objects/`,
      "--copy-props",
      "none",
      "--only-show-errors",
    ]);
    await aws(["s3", "cp", dump, `${prefix}/database.dump.age`, "--only-show-errors"]);
    const manifest = path.join(temporary, "complete.json");
    await writeFile(
      manifest,
      JSON.stringify({
        snapshot,
        createdAt: new Date().toISOString(),
        sourceBucket: deployment.bucket,
        database: "database.dump.age",
        objects: "objects/",
        encryptionKeyRequired: true,
        format: 1,
      }),
      { mode: 0o600 },
    );
    // A snapshot is usable only when this final marker exists.
    await aws(["s3", "cp", manifest, `${prefix}/complete.json`, "--only-show-errors"]);
    console.log(`Completed backup: ${prefix}`);
  } catch (error) {
    errors.push(error);
  } finally {
    const failures = [];
    for (const host of attempted) {
      try {
        await run("ssh", [...sshOptions, host, `bash -s -- ${snapshot}`], {
          input: `set -euo pipefail
exec 9>/opt/rakazo/deploy.lock
flock -n 9
[[ $(cat /opt/rakazo/maintenance 2>/dev/null) == "$1" ]] || exit 0
cd /opt/rakazo/current
docker compose --project-name rakazo --env-file .env -f compose.yml up -d --wait --wait-timeout 240 data-init api worker web
docker compose --project-name rakazo --env-file .env -f compose.yml up -d cloudflared
rm /opt/rakazo/maintenance
`,
        });
      } catch {
        failures.push(host);
      }
    }
    await rm(temporary, { recursive: true, force: true });
    if (failures.length)
      errors.push(
        new Error(
          `Some origins could not resume: ${failures.join(", ")}. Their maintenance markers remain; inspect before deploying.`,
        ),
      );
  }
  if (errors.length)
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
