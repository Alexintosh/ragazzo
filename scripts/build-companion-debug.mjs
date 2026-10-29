import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireAdapter = createRequire(path.join(root, "packages/adapters/package.json"));
const output = path.join(root, ".cache/companion/debug-bridge.cjs");
await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(root, "infra/companion/debug-bridge-server.ts")],
  outfile: output,
  platform: "node",
  target: "node18",
  format: "cjs",
  bundle: true,
  alias: { pg: requireAdapter.resolve("pg") },
  external: ["pg-native"],
  sourcemap: false,
});
console.log("Built companion debug bridge.");
