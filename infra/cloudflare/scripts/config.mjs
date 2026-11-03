import { isIP } from "node:net";

export function envObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Expected an environment object");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof item !== "string" || /[\r\n\0]/.test(item))
      throw new Error(`Invalid environment entry: ${key}`);
  }
  return value;
}

export function imageRef(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)
  )
    throw new Error("Images must be immutable registry/repository@sha256:digest references");
  return value;
}

export function validateHosts(hosts) {
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length)
    throw new Error("Supply a non-empty, unique array of SSH hosts");
  for (const host of hosts) {
    if (typeof host !== "string" || !/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
      throw new Error("SSH hosts must be user@hostname or user@IPv4, without shell syntax");
  }
  return hosts;
}

export function databaseUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a PostgreSQL URL`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error(`${label} must identify a PostgreSQL database and login`);
  if (url.searchParams.get("sslmode") !== "verify-full")
    throw new Error(`${label} must use sslmode=verify-full`);
  if (/(-pooler\.|pooler\.)/i.test(url.hostname))
    throw new Error(`${label} must use the direct/session endpoint, not a transaction pooler`);
  return url;
}

export function renderEnvironment(deployment, runtime, secrets, image, tunnelImage) {
  envObject(runtime);
  envObject(secrets);
  imageRef(image);
  imageRef(tunnelImage);
  if (
    !/^[a-f0-9]{32}$/.test(deployment.account_id) ||
    !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(deployment.hostname) ||
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(deployment.bucket) ||
    deployment.endpoint !== `https://${deployment.account_id}.r2.cloudflarestorage.com`
  )
    throw new Error("Invalid Cloudflare deployment outputs");
  const protectedKeys = [
    "NODE_ENV",
    "DATA_DIR",
    "WAKEUP_DRIVER",
    "API_HOST",
    "API_PORT",
    "API_URL",
    "API_PROXY_TARGET",
    "BETTER_AUTH_URL",
    "WEB_ORIGIN",
    "RAKAZO_HOST",
    "CONTENT_ENCRYPTION",
    "USER_DEVICES_ENABLED",
    "TRUSTED_PROXIES",
    "CLIENT_IP_HEADER",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_REGION",
    "OBJECT_STORAGE_PATH_STYLE",
    "OBJECT_STORAGE_PREFIX",
    "NODE_OPTIONS",
    "PI_SESSION_RECORDING",
    "CLOUDFLARE_API_TOKEN",
    "HCLOUD_TOKEN",
  ];
  for (const key of protectedKeys)
    if (key in runtime || key in secrets)
      throw new Error(`${key} is controlled by this deployment profile`);
  for (const key of Object.keys(runtime))
    if (key in secrets) throw new Error(`Duplicate environment entry: ${key}`);
  const all = { ...runtime, ...secrets };
  for (const [key, value] of Object.entries(all))
    if (/replace[- ]/i.test(value)) throw new Error(`Replace the example value for ${key}`);
  for (const key of [
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "ENCRYPTION_KEY",
    "BETTER_AUTH_SECRET",
    "SCREEN_PROXY_SECRET",
    "OBJECT_STORAGE_ACCESS_KEY_ID",
    "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ]) {
    if (!all[key]?.trim() || /replace[- ]/i.test(all[key]))
      throw new Error(`Configure ${key} before deployment`);
  }
  for (const key of ["ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "SCREEN_PROXY_SECRET"])
    if (all[key].length < 32) throw new Error(`${key} must have at least 32 characters`);
  const app = databaseUrl(all.DATABASE_URL, "DATABASE_URL");
  const owner = databaseUrl(all.DATABASE_MIGRATION_URL, "DATABASE_MIGRATION_URL");
  if (
    app.username === owner.username ||
    app.hostname !== owner.hostname ||
    app.port !== owner.port ||
    app.pathname !== owner.pathname
  )
    throw new Error(
      "Use distinct app/owner logins for the same direct PostgreSQL endpoint and database",
    );
  if (
    all.REALTIME_DATABASE_URL &&
    databaseUrl(all.REALTIME_DATABASE_URL, "REALTIME_DATABASE_URL").username !== app.username
  )
    throw new Error("REALTIME_DATABASE_URL must use the runtime login");
  if (
    !["none", "e2b", "novita", "daytona", "createos", "boat", "boxd"].includes(
      all.SANDBOX_PROVIDER ?? "none",
    )
  )
    throw new Error(
      "Use a supported remote sandbox or none; Docker/fake sandboxes are not part of this origin profile",
    );
  if (all.AGENT_RUNTIME && all.AGENT_RUNTIME !== "pi")
    throw new Error("This production profile uses AGENT_RUNTIME=pi");
  const pool = Number(all.DB_POOL_MAX ?? 8);
  if (!Number.isInteger(pool) || pool < 6 || pool > 100)
    throw new Error("DB_POOL_MAX must be between 6 and 100");
  if (isIP(deployment.hostname)) throw new Error("Use the Cloudflare hostname, not an origin IP");
  const origin = `https://${deployment.hostname}`;
  const { DATABASE_MIGRATION_URL, ...common } = all;
  Object.assign(common, {
    NODE_ENV: "production",
    DATA_DIR: "/data",
    CONTENT_ENCRYPTION: "on",
    WAKEUP_DRIVER: "graphile",
    AGENT_RUNTIME: "pi",
    SANDBOX_PROVIDER: all.SANDBOX_PROVIDER ?? "none",
    SIGNUPS_ENABLED: all.SIGNUPS_ENABLED ?? "false",
    USER_DEVICES_ENABLED: "false",
    PI_SESSION_RECORDING: "false",
    DB_POOL_MAX: String(pool),
    OBJECT_STORAGE_BUCKET: deployment.bucket,
    OBJECT_STORAGE_ENDPOINT: deployment.endpoint,
    OBJECT_STORAGE_REGION: "auto",
    OBJECT_STORAGE_PATH_STYLE: "true",
    OBJECT_STORAGE_PREFIX: "",
    API_URL: origin,
  });
  const api = {
    ...common,
    API_HOST: "0.0.0.0",
    API_PORT: "3100",
    BETTER_AUTH_URL: origin,
    WEB_ORIGIN: origin,
    TRUSTED_PROXIES: "web",
    CLIENT_IP_HEADER: "cf-connecting-ip",
  };
  const { BETTER_AUTH_SECRET, SCREEN_PROXY_SECRET, ...worker } = common;
  const web = {
    NODE_ENV: "production",
    RAYON_NUM_THREADS: "4",
    API_PROXY_TARGET: "http://api:3100",
    RAKAZO_HOST: deployment.hostname,
    SCREEN_PROXY_SECRET,
  };
  return {
    ".env": { IMAGE_REF: image, CLOUDFLARED_IMAGE: tunnelImage },
    "api.env": api,
    "worker.env": worker,
    "web.env": web,
    "migration.env": { DATABASE_URL: all.DATABASE_URL, DATABASE_MIGRATION_URL },
  };
}

// Compose's raw env_file format preserves dollar signs, quotes and backslashes in secrets.
export function envText(value) {
  envObject(value);
  return `${Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n")}\n`;
}
