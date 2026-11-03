import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envText, renderEnvironment, validateHosts } from "./config.mjs";
import { run, sshOptions } from "./process.mjs";
import { tunnelToken } from "./tunnel-token.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".runtime");
const json = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`Could not read valid JSON from ${file}`);
  }
};
process.umask(0o077);

async function prepare(args) {
  if (args.length !== 6)
    throw new Error(
      "prepare <terraform-output.json> <hosts.json> <runtime.json> <secrets.json> <app@sha256:...> <cloudflared@sha256:...>",
    );
  const [foundation, inventory, runtimeFile, secretsFile, image, connector] = args;
  const deployment = await json(foundation);
  const hosts = validateHosts(await json(inventory));
  const files = renderEnvironment(
    deployment,
    await json(runtimeFile),
    await json(secretsFile),
    image,
    connector,
  );
  const release = `release-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const directory = path.join(scratch, release);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, env] of Object.entries(files))
    await writeFile(path.join(directory, name), envText(env), { mode: 0o600 });
  await copyFile(path.join(root, "compose.yml"), path.join(directory, "compose.yml"));
  await copyFile(
    path.join(root, "scripts/database-check.mjs"),
    path.join(directory, "database-check.mjs"),
  );
  await copyFile(
    path.join(root, "scripts/stage-assets.mjs"),
    path.join(directory, "stage-assets.mjs"),
  );
  await writeFile(
    path.join(directory, "deployment.json"),
    JSON.stringify({ deployment, hosts, release }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `Prepared ${directory}\nNo cloud resources or servers were changed. Review configuration, then run apply with this directory.`,
  );
}

async function apply(directory) {
  if (!directory) throw new Error("apply <prepared-release-directory>");
  directory = await realpath(directory);
  const base = await realpath(scratch);
  if (path.dirname(directory) !== base)
    throw new Error("Use a release prepared under infra/cloudflare/.runtime");
  const { deployment, hosts, release } = await json(path.join(directory, "deployment.json"));
  validateHosts(hosts);
  if (!/^release-\d+-[a-f0-9]{8}$/.test(release) || path.basename(directory) !== release)
    throw new Error("Invalid release ID");
  const lock = await open(path.join(scratch, "deploy.lock"), "wx").catch(() => {
    throw new Error(
      "Another local deployment is running; inspect .runtime/deploy.lock before retrying",
    );
  });
  try {
    const connector = await tunnelToken(deployment);
    await writeFile(path.join(directory, "tunnel-token"), connector, { mode: 0o600 });
    // Stage the image's assets and collect retained builds before changing any live origin.
    const stageScript = await readFile(path.join(root, "scripts/stage-assets.sh"), "utf8");
    const archive = path.join(directory, "web-assets");
    // A retried release rebuilds its union from the current origins, never stale local files.
    await rm(archive, { recursive: true, force: true });
    await mkdir(archive, { mode: 0o700 });
    const transport = ["ssh", ...sshOptions].join(" ");
    for (const host of hosts) {
      const destination = `/opt/rakazo/releases/${release}`;
      await run("ssh", [...sshOptions, host, `install -d -m 700 ${destination}`]);
      await run("scp", [
        ...sshOptions,
        ...[
          ".env",
          "api.env",
          "worker.env",
          "web.env",
          "compose.yml",
          "tunnel-token",
          "database-check.mjs",
          "stage-assets.mjs",
        ].map((name) => path.join(directory, name)),
        `${host}:${destination}/`,
      ]);
      await run("ssh", [...sshOptions, host, `bash -s -- ${release}`], { input: stageScript });
      await run("rsync", [
        "-rlt",
        "--safe-links",
        "-e",
        transport,
        `${host}:/opt/rakazo/web-assets/`,
        `${archive}/`,
      ]);
    }
    // Barrier: every origin gets the union, including a newly added empty origin, before rollout.
    for (const host of hosts) {
      await run("rsync", [
        "-rltpog",
        "--safe-links",
        "--chmod=D750,F640",
        "--rsync-path=rsync --chown=1000:1000",
        "-e",
        transport,
        `${archive}/`,
        `${host}:/opt/rakazo/web-assets/`,
      ]);
      await run("ssh", [
        ...sshOptions,
        host,
        "chown -R 1000:1000 /opt/rakazo/web-assets && chmod -R u=rwX,g=rX,o= /opt/rakazo/web-assets",
      ]);
    }
    const remoteScript = await readFile(path.join(root, "scripts/remote-deploy.sh"), "utf8");
    for (const [index, host] of hosts.entries()) {
      const destination = `/opt/rakazo/releases/${release}`;
      const errors = [];
      try {
        if (index === 0)
          await run("scp", [
            ...sshOptions,
            path.join(directory, "migration.env"),
            `${host}:${destination}/`,
          ]);
        await run(
          "ssh",
          [...sshOptions, host, `bash -s -- ${release} ${index === 0 ? "migrate" : "serve"}`],
          { input: remoteScript },
        );
      } catch (error) {
        errors.push(error);
      } finally {
        // Also covers failed/partial scp or SSH disconnect before the remote EXIT trap.
        if (index === 0) {
          try {
            await run("ssh", [...sshOptions, host, `rm -f ${destination}/migration.env`]);
          } catch {
            errors.push(
              new Error(
                "Could not remove migration.env from the first origin; remove it securely before retrying",
              ),
            );
          }
        }
      }
      if (errors.length)
        throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
    }
    await run(process.execPath, [
      path.join(root, "scripts/smoke.mjs"),
      `https://${deployment.hostname}`,
    ]);
    console.log(
      "Deployment completed. Retain the previous image and configuration for application rollback.",
    );
  } finally {
    await rm(path.join(directory, "tunnel-token"), { force: true });
    await lock.close();
    await rm(path.join(scratch, "deploy.lock"), { force: true });
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") await prepare(args);
  else if (command === "apply" && args.length === 1) await apply(args[0]);
  else throw new Error("Use prepare or apply; see infra/cloudflare/README.md");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
