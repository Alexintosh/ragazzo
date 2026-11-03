import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Artifact, Bot } from "../../../packages/contracts/src/index.js";
import { parseRoleplayCharacterJson } from "../../../packages/contracts/src/index.js";

type Rpc = <T>(procedure: string, input?: unknown) => Promise<T>;
const spawnKey = "example:nina-illustrated-story:v1";

/** Installs the original example through the same authenticated API as the app. */
export async function installNinaStory(rpc: Rpc): Promise<Bot> {
  await rpc("preferences/update", { roleplayEnabled: true });
  const bots = await rpc<Bot[]>("bots/list");
  const existing = bots.find((bot) => bot.spawnKey === spawnKey);
  // Leave an already installed character and its ongoing story untouched.
  if (existing?.roleplayCharacter?.media?.album.length) return existing;
  const character = parseRoleplayCharacterJson(
    await readFile(new URL("./character.json", import.meta.url), "utf8"),
  ).character;
  const bot =
    existing ??
    (await rpc<Bot>("bots/create", {
      name: character.name,
      botKind: "roleplay",
      roleplayCharacter: character,
      notifyOnFinish: false,
      spawnKey,
    }));
  const manifest = JSON.parse(await readFile(new URL("./album.json", import.meta.url), "utf8")) as {
    images: Array<{ id: string; file: string; scene: string; description: string }>;
  };
  const album = [];
  for (const image of manifest.images) {
    const artifact = await rpc<Artifact>("artifacts/create", {
      botId: bot.id,
      name: image.file,
      description: image.description,
      mimeType: "image/png",
      contentBase64: (await readFile(new URL(image.file, import.meta.url))).toString("base64"),
      clientNonce: `${spawnKey}:${bot.id}:${image.id}`,
    });
    album.push({
      id: image.id,
      artifactId: artifact.id,
      description: image.description,
      scene: image.scene,
      enabled: true,
    });
  }
  return rpc<Bot>("bots/update", {
    botId: bot.id,
    expectedRoleplayCharacter: bot.roleplayCharacter,
    roleplayCharacter: {
      ...character,
      media: {
        enabled: true,
        allowSpontaneous: false,
        normalIntervalTurns: 4,
        storyIntervalTurns: 1,
        album,
      },
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = new URL(process.argv[2] ?? "http://127.0.0.1:5180");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Provide only the application's base URL");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  )
    throw new Error("Use HTTPS for a remote server");
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone CLI; never run or cached by Turbo.
  const cookie = process.env.RAKAZO_SESSION_COOKIE;
  if (!cookie)
    throw new Error(
      "Set RAKAZO_SESSION_COOKIE to your signed-in session cookie; it is never printed or saved",
    );
  const rpc: Rpc = async <T>(procedure: string, input?: unknown): Promise<T> => {
    const response = await fetch(new URL(`/rpc/${procedure}`, base), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", origin: base.origin, cookie },
      body: JSON.stringify({ json: input }),
    });
    if (!response.ok)
      throw new Error(
        `${procedure} failed (${response.status}); verify your session and Docker configuration`,
      );
    const body = (await response.json()) as { json: T };
    return body.json;
  };
  const bot = await installNinaStory(rpc);
  console.log(new URL(`/app/${bot.id}`, base).href);
}
