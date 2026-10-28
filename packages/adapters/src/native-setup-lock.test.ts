import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireSetupProviderLock } from "./native-setup-lock.js";
import { setupDirectory } from "./native-setup-paths.js";

const directories: string[] = [];
const owner = { sessionId: "fake-session", registrationId: "fake-host", scopeKey: "a".repeat(64) };
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-setup-lock-"));
  directories.push(root);
  return root;
}
it("releases only its own provider fence and preserves replacement ownership", async () => {
  const root = await fixture();
  const release = await acquireSetupProviderLock(root, "codex", owner);
  const locks = path.join(root, "native-setup/locks");
  await expect(acquireSetupProviderLock(root, "codex", owner)).rejects.toThrow("already pending");
  await rename(path.join(locks, "codex"), path.join(locks, "retired"));
  const replacementRelease = await acquireSetupProviderLock(root, "codex", {
    ...owner,
    sessionId: "replacement",
  });
  await expect(release()).rejects.toThrow("ownership changed");
  expect(JSON.parse(await readFile(path.join(locks, "codex/owner.json"), "utf8")).sessionId).toBe(
    "replacement",
  );
  await replacementRelease();
  expect(await readdir(locks)).toEqual(["retired"]);
});
it("preserves a fence whose token changed instead of removing another owner's record", async () => {
  const root = await fixture();
  const release = await acquireSetupProviderLock(root, "codex", owner);
  const file = path.join(root, "native-setup/locks/codex/owner.json");
  await writeFile(file, JSON.stringify({ ...owner, token: "replacement-token" }));
  await expect(release()).rejects.toThrow("ownership changed");
  expect(JSON.parse(await readFile(file, "utf8")).token).toBe("replacement-token");
});
it("refuses symlink coordinator directories and existing symlink provider fences", async () => {
  const root = await fixture(),
    outside = await fixture();
  const setup = await setupDirectory(root, "native-setup");
  await symlink(outside, path.join(setup, "locks"));
  await expect(acquireSetupProviderLock(root, "codex", owner)).rejects.toThrow(
    "Unsafe setup directory",
  );
  await rm(path.join(setup, "locks"));
  await mkdir(path.join(setup, "locks"), { mode: 0o700 });
  await symlink(outside, path.join(setup, "locks/codex"));
  await expect(acquireSetupProviderLock(root, "codex", owner)).rejects.toThrow("already pending");
  expect(await readdir(outside)).toEqual([]);
});
