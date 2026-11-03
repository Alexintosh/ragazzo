import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  databaseUrl,
  envObject,
  envText,
  imageRef,
  renderEnvironment,
  validateHosts,
} from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = `registry.example.com/fork/app@sha256:${"a".repeat(64)}`;
const connector = `docker.io/cloudflare/cloudflared@sha256:${"b".repeat(64)}`;
const deployment = {
  account_id: "1".repeat(32),
  hostname: "bots.example.com",
  bucket: "fixture-data",
  backup_bucket: "fixture-backups",
  tunnel_id: "11111111-1111-4111-8111-111111111111",
  endpoint: `https://${"1".repeat(32)}.r2.cloudflarestorage.com`,
};
const secrets = {
  DATABASE_URL: "postgresql://app:fixture@db.example.com/db?sslmode=verify-full",
  DATABASE_MIGRATION_URL: "postgresql://owner:fixture@db.example.com/db?sslmode=verify-full",
  ENCRYPTION_KEY: "fixture-key-".repeat(4),
  BETTER_AUTH_SECRET: "fixture-auth-".repeat(4),
  SCREEN_PROXY_SECRET: "fixture-screen-".repeat(4),
  OBJECT_STORAGE_ACCESS_KEY_ID: "fixture-access",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "fixture-$literal-'quotes'-\\backslash",
};

test("separates migration, app and browser privileges and fixes the R2 connection", () => {
  const files = renderEnvironment(deployment, {}, secrets, image, connector);
  assert.equal(files["api.env"].DATABASE_MIGRATION_URL, undefined);
  assert.equal(files["worker.env"].DATABASE_MIGRATION_URL, undefined);
  assert.equal(files["worker.env"].BETTER_AUTH_SECRET, undefined);
  assert.equal(files["web.env"].DATABASE_URL, undefined);
  assert.equal(files["web.env"].OBJECT_STORAGE_SECRET_ACCESS_KEY, undefined);
  assert.equal(files["migration.env"].DATABASE_MIGRATION_URL, secrets.DATABASE_MIGRATION_URL);
  assert.equal(files["api.env"].OBJECT_STORAGE_REGION, "auto");
  assert.equal(files["api.env"].CONTENT_ENCRYPTION, "on");
  assert.equal(files["api.env"].SIGNUPS_ENABLED, "false");
  assert.equal(files["api.env"].CLIENT_IP_HEADER, "cf-connecting-ip");
});

test("fails closed for unsafe environment entries, mutable images and SSH injection", () => {
  assert.throws(() => envObject({ SECRET: "one\nOTHER=two" }));
  assert.throws(() => imageRef("registry.example.com/app:latest"));
  assert.throws(() => validateHosts(["root@host;echo-injected"]));
  assert.throws(() => validateHosts(["root@host", "root@host"]));
  assert.throws(() =>
    renderEnvironment(
      deployment,
      { NODE_OPTIONS: "--import=/tmp/code" },
      secrets,
      image,
      connector,
    ),
  );
  assert.throws(() =>
    renderEnvironment(deployment, { SANDBOX_PROVIDER: "docker" }, secrets, image, connector),
  );
  assert.throws(() =>
    renderEnvironment(deployment, { DB_POOL_MAX: "2" }, secrets, image, connector),
  );
});

test("requires authenticated TLS, separate database roles and a direct endpoint", () => {
  assert.throws(() =>
    databaseUrl("postgres://app:x@db.example.com/db?sslmode=disable", "database"),
  );
  assert.throws(() =>
    databaseUrl("postgres://app:x@db-pooler.example.com/db?sslmode=verify-full", "database"),
  );
  assert.throws(() =>
    renderEnvironment(
      deployment,
      {},
      { ...secrets, DATABASE_MIGRATION_URL: secrets.DATABASE_URL },
      image,
      connector,
    ),
  );
  assert.throws(() =>
    renderEnvironment(
      deployment,
      {},
      {
        ...secrets,
        DATABASE_MIGRATION_URL: secrets.DATABASE_MIGRATION_URL.replace("/db?", "/other?"),
      },
      image,
      connector,
    ),
  );
});

test("Docker Compose preserves raw secrets, keeps owner credentials out of runtime, and publishes no ports", {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone deployment checks are not Turbo tasks.
  skip: !process.env.VERIFY_COMPOSE,
}, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rakazo-compose-test-"));
  try {
    const files = renderEnvironment(deployment, {}, secrets, image, connector);
    for (const [name, env] of Object.entries(files))
      writeFileSync(path.join(temporary, name), envText(env), { mode: 0o600 });
    writeFileSync(
      path.join(temporary, "compose.yml"),
      readFileSync(path.join(root, "compose.yml")),
    );
    writeFileSync(path.join(temporary, "tunnel-token"), "fixture-token");
    const result = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          ".env",
          "--profile",
          "maintenance",
          "-f",
          "compose.yml",
          "config",
          "--format",
          "json",
        ],
        { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    assert.equal(
      result.services.api.environment.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      // `config` re-escapes dollars so its output is a reusable Compose document.
      secrets.OBJECT_STORAGE_SECRET_ACCESS_KEY.replaceAll("$", () => "$$"),
    );
    assert.equal(result.services.api.environment.DATABASE_MIGRATION_URL, undefined);
    assert.equal(
      result.services.migrate.environment.DATABASE_MIGRATION_URL,
      secrets.DATABASE_MIGRATION_URL,
    );
    assert.equal(result.services.web.environment.DATABASE_URL, undefined);
    assert.ok(Object.values(result.services).every((service) => !service.ports?.length));
    // A real, network-isolated process proves raw env_file values survive runtime parsing.
    writeFileSync(
      path.join(temporary, "probe.json"),
      JSON.stringify({
        services: {
          probe: {
            image: "postgres:18-alpine",
            network_mode: "none",
            env_file: [{ path: "api.env", format: "raw" }],
            entrypoint: [
              "/bin/sh",
              "-c",
              "printf '%s' \"$$OBJECT_STORAGE_SECRET_ACCESS_KEY\" | sha256sum",
            ],
          },
        },
      }),
    );
    const checksum = execFileSync(
      "docker",
      [
        "compose",
        "--project-name",
        `rakazo-env-${process.pid}`,
        "-f",
        "probe.json",
        "run",
        "--rm",
        "--no-deps",
        "--pull",
        "never",
        "probe",
      ],
      { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .trim()
      .split(/\s+/)[0];
    assert.equal(
      checksum,
      createHash("sha256").update(secrets.OBJECT_STORAGE_SECRET_ACCESS_KEY).digest("hex"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("rollout stops after a failed first-node migration and never logs secrets", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rakazo-deploy-test-"));
  let directory;
  try {
    const writeJson = (name, value) => {
      const file = path.join(temporary, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const cli = path.join(root, "scripts/deploy.mjs");
    const output = execFileSync(
      process.execPath,
      [
        cli,
        "prepare",
        writeJson("deployment.json", deployment),
        writeJson("hosts.json", ["root@192.0.2.1", "root@192.0.2.2"]),
        writeJson("runtime.json", {}),
        writeJson("secrets.json", secrets),
        image,
        connector,
      ],
      { encoding: "utf8" },
    );
    directory = output.split("\n")[0].replace("Prepared ", "");
    assert.ok(directory.startsWith(path.join(root, ".runtime/release-")));
    const events = path.join(temporary, "events.jsonl");
    const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify({ tool: process.argv[1].split('/').pop(), args }) + '\\n');
if(args.some(a => a.endsWith(' migrate'))) process.exit(9);
`;
    for (const command of ["ssh", "scp", "rsync"])
      writeFileSync(path.join(temporary, command), shim, { mode: 0o700 });
    const mock = path.join(temporary, "fetch.mjs");
    writeFileSync(
      mock,
      `globalThis.fetch = async () => new Response(JSON.stringify({success:true,result:'fixtureToken'}), {headers:{'content-type':'application/json'}});`,
    );
    const apply = () =>
      execFileSync(process.execPath, ["--import", mock, cli, "apply", directory], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${temporary}:${process.env.PATH}`,
          TEST_EVENTS: events,
          CLOUDFLARE_API_TOKEN: "fixture-api-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let failure;
    try {
      apply();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "migration failure must fail rollout");
    const calls = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith(" migrate"))));
    assert.ok(calls.every((call) => !call.args.some((arg) => arg.endsWith(" serve"))));
    const migration = calls.findIndex((call) => call.args.some((arg) => arg.endsWith(" migrate")));
    const synchronizations = calls.flatMap((call, index) => (call.tool === "rsync" ? [index] : []));
    assert.equal(synchronizations.length, 4, "collect and distribute archives on both origins");
    assert.ok(
      synchronizations.every((index) => index < migration),
      "asset barrier precedes migration/rollout",
    );
    const logged = `${output}${failure.stdout}${failure.stderr}`;
    for (const value of Object.values(secrets)) assert.ok(!logged.includes(value));
    assert.throws(() => readFileSync(path.join(directory, "tunnel-token")));
    assert.throws(apply, (error) => {
      assert.match(error.stderr.toString(), /ssh failed/);
      assert.doesNotMatch(error.stderr.toString(), /EEXIST/);
      return true;
    });
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("asset staging retains previous builds and supplies their files to a new origin", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rakazo-assets-test-"));
  try {
    mkdirSync(path.join(temporary, "src"));
    symlinkSync(
      path.resolve(root, "../../apps/web/src/asset-archive.ts"),
      path.join(temporary, "src/asset-archive.ts"),
    );
    mkdirSync(path.join(temporary, "dist/assets"), { recursive: true });
    mkdirSync(path.join(temporary, "asset-archive"));
    const stage = (id, file) => {
      writeFileSync(path.join(temporary, "dist/build-id"), id);
      writeFileSync(path.join(temporary, "dist/assets", file), id);
      execFileSync(process.execPath, [path.join(root, "scripts/stage-assets.mjs")], {
        cwd: temporary,
      });
      rmSync(path.join(temporary, "dist/assets", file));
    };
    stage("old", "old-hash.js");
    stage("new", "new-hash.js");
    const added = path.join(temporary, "added-origin");
    cpSync(path.join(temporary, "asset-archive"), added, { recursive: true });
    for (const archive of [path.join(temporary, "asset-archive"), added]) {
      assert.equal(readFileSync(path.join(archive, "assets/old-hash.js"), "utf8"), "old");
      assert.equal(readFileSync(path.join(archive, "assets/new-hash.js"), "utf8"), "new");
      assert.ok(
        JSON.parse(readFileSync(path.join(archive, "builds/old.json"))).files.includes(
          "old-hash.js",
        ),
      );
      assert.ok(
        JSON.parse(readFileSync(path.join(archive, "builds/new.json"))).files.includes(
          "new-hash.js",
        ),
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
