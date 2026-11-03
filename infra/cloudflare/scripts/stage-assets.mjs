import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Run from the image's apps/web directory, using its existing retention and manifest logic.
const { archiveAssets } = await import(pathToFileURL(path.resolve("src/asset-archive.ts")));
const result = archiveAssets({
  assetsDir: "dist/assets",
  archiveDir: "asset-archive",
  buildId: readFileSync("dist/build-id", "utf8").trim(),
  now: Date.now(),
});
if (!result) throw new Error("Asset archive is unavailable");
