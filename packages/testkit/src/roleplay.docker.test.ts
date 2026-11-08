import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import { DockerSandboxProvider } from "@rakazo/adapters";
import type { Bot, RpcOutput } from "@rakazo/contracts";
import { parseRoleplayCharacterJson } from "@rakazo/contracts";
import { asSystem, createDb } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { installNinaStory } from "../../../examples/roleplay/nina-story/install.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.RUN_ROLEPLAY_DOCKER === "1" && process.env.VERIFY_DATABASE === "1";
const origin = "http://127.0.0.1:5173";
const token = "roleplay-fixture-supervisor-token-32chars";
type App = { request(input: string, init?: RequestInit): Promise<Response> };

// Opt-in: use an existing database and image. Never downloads, builds, resets a
// database, or changes existing identities/settings. All owned resources are removed.
describe.skipIf(!enabled)("roleplay product journey with real PostgreSQL and Docker", () => {
  it("isolates stories, streams through the internal runtime, cancels, queues, and clears", async () => {
    execFileSync("docker", ["image", "inspect", "rakazo/computer:local"], { stdio: "pipe" });
    if (!process.env.DOCKER_HOST && !process.env.DOCKER_SOCKET)
      vi.stubEnv(
        "DOCKER_HOST",
        execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
          encoding: "utf8",
        }).trim(),
      );
    await mkdir(path.resolve(".cache"), { recursive: true });
    const dataDir = await mkdtemp(path.resolve(".cache/roleplay-integration-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("SANDBOX_SUPERVISOR_TOKEN", token);
    vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", "true");
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "open");
    vi.stubEnv("RAKAZO_COMPUTER_IMAGE", "rakazo/computer:local");
    const card = parseRoleplayCharacterJson(
      JSON.stringify({
        spec: "chara_card_v2",
        data: {
          name: "Mira",
          description: "CHARACTER_FIXTURE",
          personality: "PERSONALITY_FIXTURE",
          scenario: "SCENARIO_FIXTURE",
          first_mes: "{{char}} greets {{user}}.",
          mes_example: "EXAMPLE_FIXTURE",
          system_prompt: "SYSTEM_FIXTURE",
          post_history_instructions: "POST_HISTORY_FIXTURE",
          extensions: { executable: "UNIMPORTED_SCRIPT_FIXTURE" },
          character_book: {
            scan_depth: 2,
            entries: [
              { keys: ["ember"], content: "EMBER_LORE_FIXTURE", enabled: true },
              { keys: ["unseen"], content: "INACTIVE_LORE_FIXTURE", enabled: true },
            ],
          },
        },
      }),
    );
    expect(card.warnings.length).toBeGreaterThan(0);
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const queueOpened = Promise.withResolvers<void>();
    const queueRelease = Promise.withResolvers<void>();
    const dialogueTools = (request: ModelEmulatorRequest) => {
      expect((request.tools ?? []).map((tool) => tool.function.name)).toEqual([
        "schedule_create",
        "schedule_list",
        "schedule_update",
        "schedule_cancel",
      ]);
    };
    const baseCheck = (request: ModelEmulatorRequest) => {
      // These are protocol/data-flow assertions over synthetic fixtures, not
      // natural-language quality judgments.
      dialogueTools(request);
      expect(
        request.messages.every((message) => ["system", "user", "assistant"].includes(message.role)),
      ).toBe(true);
      const sent = JSON.stringify(request.messages);
      for (const field of [
        "CHARACTER_FIXTURE",
        "PERSONALITY_FIXTURE",
        "SCENARIO_FIXTURE",
        "EXAMPLE_FIXTURE",
        "SYSTEM_FIXTURE",
        "POST_HISTORY_FIXTURE",
      ])
        expect(sent).toContain(field);
      for (const forbidden of [
        "UNIMPORTED_SCRIPT_FIXTURE",
        "INACTIVE_LORE_FIXTURE",
        "GLOBAL_AGENT_MEMORY_FIXTURE",
        "SAME_BOT_STORY_REPLY",
      ])
        expect(sent).not.toContain(forbidden);
    };
    const legacySteps: ModelEmulatorStep[] = [
      {
        expect(request) {
          baseCheck(request);
          expect(JSON.stringify(request.messages)).toContain("EMBER_LORE_FIXTURE");
        },
        response: { type: "text", text: "STORY_A_REPLY" },
      },
      {
        expect(request) {
          baseCheck(request);
          const sent = JSON.stringify(request.messages);
          expect(sent).not.toContain("STORY_A_REPLY");
          expect(sent).not.toContain("EMBER_LORE_FIXTURE");
        },
        response: { type: "text", text: "STORY_B_REPLY" },
      },
      {
        expect(request) {
          baseCheck(request);
          const sent = JSON.stringify(request.messages);
          for (const otherStory of ["STORY_A_REPLY", "STORY_B_REPLY", "EMBER_LORE_FIXTURE"])
            expect(sent).not.toContain(otherStory);
          expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
        },
        response: { type: "text", text: "SAME_BOT_STORY_REPLY" },
      },
      {
        expect(request) {
          baseCheck(request);
          expect(JSON.stringify(request.messages)).toContain("STORY_A_REPLY");
        },
        response: {
          type: "hold",
          text: "CANCELLED_PARTIAL_FIXTURE ".repeat(40),
          onOpen: opened.resolve,
          onClose: closed.resolve,
        },
      },
      {
        expect(request) {
          baseCheck(request);
          expect(JSON.stringify(request.messages)).not.toContain("CANCELLED_PARTIAL_FIXTURE");
        },
        response: { type: "text", text: "REUSED_STORY_REPLY" },
      },
      {
        async expect(request) {
          baseCheck(request);
          queueOpened.resolve();
          await queueRelease.promise;
        },
        response: { type: "text", text: "BEFORE_QUEUE_REPLY" },
      },
      {
        expect(request) {
          baseCheck(request);
          expect(request.messages.at(-1)?.content).toContain("QUEUED_PLAYER_INPUT");
          expect(JSON.stringify(request.messages)).toContain("BEFORE_QUEUE_REPLY");
        },
        response: { type: "text", text: "QUEUED_STORY_REPLY" },
      },
      {
        expect(request) {
          baseCheck(request);
          expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
          const sent = JSON.stringify(request.messages);
          for (const prior of [
            "STORY_A_REPLY",
            "REUSED_STORY_REPLY",
            "QUEUED_STORY_REPLY",
            "EMBER_LORE_FIXTURE",
          ])
            expect(sent).not.toContain(prior);
        },
        response: { type: "text", text: "FRESH_STORY_REPLY" },
      },
    ];
    const directionStep = (
      direction: {
        storyMode: boolean;
        scene: string;
        imageId: string | null;
        imageRequested: boolean;
      },
      check?: (data: Record<string, unknown>) => void,
    ): ModelEmulatorStep => ({
      expect(request) {
        expect(request.tools ?? []).toEqual([]);
        expect(request.messages).toHaveLength(2);
        expect(request.messages[0]?.role).toBe("system");
        expect(request.messages[0]?.content).toContain("Roleplay direction rubric v1");
        expect(request.messages[1]?.role).toBe("user");
        const data = JSON.parse(String(request.messages[1]?.content)) as Record<string, unknown>;
        expect(data.latestPlayerMessage).toEqual(expect.any(String));
        expect(data.character).toEqual(expect.objectContaining({ name: expect.any(String) }));
        check?.(data);
      },
      response: { type: "text", text: JSON.stringify(direction) },
    });
    const forestScene = "Bosco al crepuscolo";
    const forestDirection = {
      storyMode: true,
      scene: forestScene,
      imageId: "forest",
      imageRequested: false,
    };
    const laterScenes = [
      {
        id: "bridge",
        scene: "Il ponte sul ruscello",
        file: "02-bridge.png",
        input: "Seguiamo Nina e Tilla fino al ponte sul ruscello.",
        reply: "Sul ponte Nina incontra il gufo e guarda il riflesso di Tilla nell'acqua.",
      },
      {
        id: "homecoming",
        scene: "La collina delle stelle",
        file: "03-homecoming.png",
        input: "Accompagniamo Tilla sulla collina per ritrovare la strada di casa.",
        reply: "Dalla collina Nina e il gufo salutano Tilla che ritrova la strada verso il cielo.",
      },
    ];
    const ninaSteps: ModelEmulatorStep[] = [
      directionStep(forestDirection, (data) => {
        expect(data.latestPlayerMessage).toBe("Vorrei iniziare l'avventura di Nina nel bosco.");
        expect(data.current).toMatchObject({ storyMode: false, sentImageIds: [] });
        expect(data.media).toMatchObject({
          enabled: true,
          album: [
            expect.objectContaining({ id: "forest" }),
            expect.objectContaining({ id: "bridge" }),
            expect.objectContaining({ id: "homecoming" }),
          ],
        });
        expect(JSON.stringify(data)).not.toContain("STORY_A_REPLY");
      }),
      {
        expect(request) {
          dialogueTools(request);
          const sent = JSON.stringify(request.messages);
          expect(sent).toContain("Story mode is active");
          expect(sent).toContain(forestScene);
          expect(sent).toContain("This reply will include exactly one available album image");
          expect(sent).not.toContain("CHARACTER_FIXTURE");
        },
        response: {
          type: "text",
          text: "Nina trova Tilla nella lanterna. Come possiamo aiutarla?",
        },
      },
      ...laterScenes.flatMap((scene, index): ModelEmulatorStep[] => [
        directionStep(
          { storyMode: true, scene: scene.scene, imageId: scene.id, imageRequested: false },
          (data) => {
            expect(data.latestPlayerMessage).toBe(scene.input);
            expect(data.current).toMatchObject({
              storyMode: true,
              scene: index === 0 ? forestScene : laterScenes[index - 1]!.scene,
              sentImageIds: ["forest", ...laterScenes.slice(0, index).map((prior) => prior.id)],
            });
          },
        ),
        {
          expect(request) {
            dialogueTools(request);
            const sent = JSON.stringify(request.messages);
            expect(sent).toContain(scene.scene);
            expect(sent).toContain("This reply will include exactly one available album image");
          },
          response: { type: "text", text: scene.reply },
        },
      ]),
      directionStep(
        { ...forestDirection, scene: laterScenes[1]!.scene, imageRequested: true },
        (data) => {
          expect(data.latestPlayerMessage).toBe("Mostrami di nuovo la prima immagine.");
          expect(data.current).toMatchObject({
            storyMode: true,
            scene: laterScenes[1]!.scene,
            sentImageIds: ["forest", "bridge", "homecoming"],
          });
        },
      ),
      {
        expect(request) {
          dialogueTools(request);
          expect(JSON.stringify(request.messages)).toContain(
            "This reply will include exactly one available album image",
          );
        },
        response: { type: "text", text: "Ecco di nuovo Nina e Tilla nel bosco." },
      },
    ];
    const model = await startModelEmulator({
      apiKey: "roleplay-offline-fixture-key",
      steps: [
        ...legacySteps.flatMap((step) => [
          directionStep(
            { storyMode: false, scene: "", imageId: null, imageRequested: false },
            (data) => {
              expect(data.media).toBeNull();
              const sent = JSON.stringify(data);
              for (const forbidden of [
                "GLOBAL_AGENT_MEMORY_FIXTURE",
                "SAME_BOT_STORY_REPLY",
                "UNIMPORTED_SCRIPT_FIXTURE",
              ])
                expect(sent).not.toContain(forbidden);
            },
          ),
          step,
        ]),
        ...ninaSteps,
      ],
    });
    const { supervisorApp } = await import("@rakazo/sandbox-supervisor");
    const server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    const supervisorUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sandbox = new DockerSandboxProvider(supervisorUrl, token);
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandbox,
      sandboxProvider: "docker",
      sandboxSupervisorUrl: supervisorUrl,
      sandboxSupervisorToken: token,
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      contentEncryption: true,
      mcpAllowPrivateEndpoint: true,
    });
    const fixtureDb = createDb(process.env.DATABASE_URL!, { encryptContent: true });
    const db = asSystem(fixtureDb.prisma, "isolated roleplay fixture");
    const bots: Bot[] = [];
    let identity: { userId: string; spaceId: string } | undefined;
    const failures: unknown[] = [];
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `roleplay-${randomUUID()}@example.test`,
          password: "fixture-password12",
          name: "Roleplay fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
      identity = { userId: me.userId, spaceId: me.spaceId };
      await rpc(handles.app, cookie, "preferences/update", { roleplayEnabled: true });
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "roleplay-offline-fixture-key",
        contextWindow: 32_768,
        maxTokens: 1024,
      });
      for (const name of ["Story A", "Story B"]) {
        bots.push(
          await rpc<Bot>(handles.app, cookie, "bots/create", {
            name,
            title: "",
            description: "",
            instructions: "",
            notifyOnFinish: false,
            botKind: "roleplay",
            roleplayCharacter: card.character,
          }),
        );
      }
      const [a, b] = bots as [Bot, Bot];
      const owned = await db.bot.findUniqueOrThrow({ where: { id: a.id } });
      identity = { userId: owned.userId, spaceId: owned.spaceId };
      expect(a).toMatchObject({
        botKind: "roleplay",
        runtimeKind: "pi",
        executionTarget: "docker",
        computerMode: "dedicated",
        fleetManagement: false,
      });
      expect(a.threadId).not.toBe(b.threadId);
      expect(await db.run.count({ where: { botId: { in: bots.map((bot) => bot.id) } } })).toBe(0);
      await db.thread.update({
        where: { id: a.threadId },
        data: { historyCompactionSummary: "GLOBAL_AGENT_MEMORY_FIXTURE" },
      });
      const wait = async (runId: string) => {
        await expect
          .poll(
            async () => {
              const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
              return ["completed", "failed", "cancelled"].includes(run.status);
            },
            { timeout: 90_000, interval: 100 },
          )
          .toBe(true);
        const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
        if (run.status !== "completed") {
          try {
            model.assertComplete();
          } catch (cause) {
            throw new Error(run.error ?? "Story run did not complete", { cause });
          }
        }
        expect(run.status, run.error ?? "Story run did not complete").toBe("completed");
      };
      const send = (bot: Bot, text: string) =>
        rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text,
          clientNonce: randomUUID(),
        });
      const first = await send(a, "ember STORY_A_INPUT");
      await wait(first.runId);
      const second = await send(b, "STORY_B_INPUT");
      await wait(second.runId);
      const separateStory = await rpc<{ id: string; threadId: string; runId: string }>(
        handles.app,
        cookie,
        "tasks/create",
        {
          botId: a.id,
          text: "SAME_BOT_SEPARATE_STORY_INPUT",
          clientNonce: randomUUID(),
        },
      );
      expect(separateStory.threadId).not.toBe(a.threadId);
      await wait(separateStory.runId);
      const separateState = (
        await db.thread.findUniqueOrThrow({ where: { id: separateStory.threadId } })
      ).roleplayState;
      expect(separateState).toMatchObject({
        threadId: separateStory.threadId,
        botId: a.id,
        turnCount: 1,
        activeLoreEntries: [],
      });
      const aState = (await db.thread.findUniqueOrThrow({ where: { id: a.threadId } }))
        .roleplayState;
      expect(aState).toMatchObject({
        threadId: a.threadId,
        botId: a.id,
        turnCount: 1,
        activeLoreEntries: [0],
      });
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: b.threadId } })).roleplayState,
      ).toMatchObject({ threadId: b.threadId, botId: b.id, turnCount: 1, activeLoreEntries: [] });
      const computers = await db.computer.findMany({
        where: { bots: { some: { id: { in: bots.map((bot) => bot.id) } } } },
      });
      expect(computers).toHaveLength(2);
      for (const computer of computers) {
        expect(computer).toMatchObject({
          kind: "docker",
          scope: "dedicated",
          executionTarget: "docker",
          state: "running",
        });
        const inspect = JSON.parse(
          execFileSync("docker", ["inspect", computer.providerRef!], { encoding: "utf8" }),
        )[0];
        expect(inspect.State.Running).toBe(true);
      }
      const raw = await db.$queryRaw<
        Array<{ state: unknown; character: unknown }>
      >`SELECT t."roleplayState" AS state, b."roleplayCharacter" AS character FROM threads t JOIN bots b ON t."botId"=b.id WHERE b.id=${a.id}`;
      expect(JSON.stringify(raw)).toContain("$sealed");
      expect(JSON.stringify(raw)).not.toContain("CHARACTER_FIXTURE");
      const cancelled = await send(a, "CANCEL_PLAYER_INPUT");
      await opened.promise;
      // Scheduling buffers unverified dialogue; the open model request and its
      // live execution lease prove that Stop interrupts an in-flight turn.
      expect((await db.run.findUniqueOrThrow({ where: { id: cancelled.runId } })).status).toBe(
        "running",
      );
      expect(
        await db.computerExecutionLease.count({
          where: { runId: cancelled.runId, expiresAt: { gt: new Date() } },
        }),
      ).toBeGreaterThan(0);
      await rpc(handles.app, cookie, "threads/stop", { botId: a.id });
      await closed.promise;
      await expect
        .poll(
          () =>
            db.computerExecutionLease.count({
              where: { runId: cancelled.runId, expiresAt: { gt: new Date() } },
            }),
          {
            timeout: 10_000,
          },
        )
        .toBe(0);
      expect((await db.run.findUniqueOrThrow({ where: { id: cancelled.runId } })).status).toBe(
        "cancelled",
      );
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: a.threadId } })).roleplayState,
      ).toEqual(aState);
      const reused = await send(a, "REUSE_PLAYER_INPUT");
      await wait(reused.runId);
      const beforeQueue = await send(a, "WAIT_PLAYER_INPUT");
      await queueOpened.promise;
      await rpc(handles.app, cookie, "threads/enqueue", {
        botId: a.id,
        text: "QUEUED_PLAYER_INPUT",
        clientNonce: randomUUID(),
      });
      queueRelease.resolve();
      await wait(beforeQueue.runId);
      await expect
        .poll(
          async () =>
            (await db.thread.findUniqueOrThrow({ where: { id: a.threadId } })).roleplayState,
          { timeout: 20_000, interval: 100 },
        )
        .toMatchObject({ turnCount: 4 });
      expect(
        await db.steeringMessage.count({ where: { botId: a.id, claimedAt: { not: null } } }),
      ).toBe(0);
      expect(await db.event.count({ where: { botId: a.id, type: "run.steering.claimed" } })).toBe(
        1,
      );
      const bState = (await db.thread.findUniqueOrThrow({ where: { id: b.threadId } }))
        .roleplayState;
      await rpc(handles.app, cookie, "threads/clear", { botId: a.id });
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: a.threadId } })).roleplayState,
      ).toBeNull();
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: b.threadId } })).roleplayState,
      ).toEqual(bState);
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: separateStory.threadId } }))
          .roleplayState,
      ).toEqual(separateState);
      const fresh = await send(a, "FRESH_PLAYER_INPUT");
      await wait(fresh.runId);
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: a.threadId } })).roleplayState,
      ).toMatchObject({ turnCount: 1, activeLoreEntries: [] });
      expect(
        await db.event.count({
          where: { botId: { in: bots.map((bot) => bot.id) }, type: { startsWith: "agent.tool" } },
        }),
      ).toBe(0);
      expect(
        await db.memoryDocument.count({ where: { botId: { in: bots.map((bot) => bot.id) } } }),
      ).toBe(0);
      const thread = await rpc<{ messages: Array<{ blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: a.id },
      );
      expect(thread.messages.at(-1)?.blocks).toEqual([{ kind: "text", text: "FRESH_STORY_REPLY" }]);
      const reply = await db.message.findFirstOrThrow({
        where: { runId: fresh.runId, role: "bot" },
      });
      const runsBeforeReaction = await db.run.count({ where: { botId: a.id } });
      const reacted = await rpc<{ runIds: string[] }>(handles.app, cookie, "threads/react", {
        botId: a.id,
        messageId: reply.id,
        reaction: "👍",
        clientNonce: randomUUID(),
      });
      expect(reacted.runIds).toEqual([]);
      expect(await db.run.count({ where: { botId: a.id } })).toBe(runsBeforeReaction);
      expect(
        (
          await db.message.findFirstOrThrow({
            where: { replyToMessageId: reply.id, role: "user" },
            orderBy: { seq: "desc" },
          })
        ).blocks,
      ).toEqual([{ kind: "text", text: "👍" }]);
      // Install the original illustrated example through the authenticated product API.
      const installRpc = <T>(procedure: string, input?: unknown) =>
        rpc<T>(handles.app, cookie, procedure, input);
      const nina = await installNinaStory(installRpc);
      bots.push(nina);
      const album = nina.roleplayCharacter!.media!.album;
      expect(album.map((image) => image.id)).toEqual(["forest", "bridge", "homecoming"]);
      const forest = album.find((image) => image.id === "forest")!;
      const installedArtifacts = await db.artifact.count({ where: { botId: nina.id } });
      expect(installedArtifacts).toBe(3);
      expect((await installNinaStory(installRpc)).id).toBe(nina.id);
      expect(await db.artifact.count({ where: { botId: nina.id } })).toBe(installedArtifacts);
      const initialMedia = await rpc<RpcOutput<"bots/roleplayMedia">>(
        handles.app,
        cookie,
        "bots/roleplayMedia",
        { botId: nina.id },
      );
      expect(initialMedia).toMatchObject({
        storyMode: false,
        scene: "",
        artifacts: expect.arrayContaining([expect.objectContaining({ id: forest.artifactId })]),
      });
      const illustrated = await send(nina, "Vorrei iniziare l'avventura di Nina nel bosco.");
      await wait(illustrated.runId);
      const illustratedThread = await rpc<RpcOutput<"threads/get">>(
        handles.app,
        cookie,
        "threads/get",
        { botId: nina.id },
      );
      const firstIllustration = illustratedThread.messages.at(-1)!;
      expect(firstIllustration.blocks).toEqual([
        { kind: "text", text: "Nina trova Tilla nella lanterna. Come possiamo aiutarla?" },
        expect.objectContaining({
          kind: "image",
          artifactId: forest.artifactId,
          mimeType: "image/png",
          name: "01-forest.png",
        }),
      ]);
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: nina.threadId } })).roleplayState,
      ).toMatchObject({
        turnCount: 1,
        media: {
          storyMode: true,
          scene: forestScene,
          sentImageIds: ["forest"],
          lastImageTurn: 1,
          turn: 1,
        },
      });
      const imageContent = await rpc<RpcOutput<"artifacts/get">>(
        handles.app,
        cookie,
        "artifacts/get",
        { botId: nina.id, artifactId: forest.artifactId },
      );
      const sourceBytes = await readFile(
        new URL("../../../examples/roleplay/nina-story/01-forest.png", import.meta.url),
      );
      expect(imageContent.mimeType).toBe("image/png");
      expect(Buffer.from(imageContent.contentBase64, "base64")).toEqual(sourceBytes);
      for (const [index, scene] of laterScenes.entries()) {
        const sceneTurn = await send(nina, scene.input);
        await wait(sceneTurn.runId);
        const image = album.find((entry) => entry.id === scene.id)!;
        const sceneThread = await rpc<RpcOutput<"threads/get">>(
          handles.app,
          cookie,
          "threads/get",
          { botId: nina.id },
        );
        expect(sceneThread.messages.at(-1)?.blocks).toEqual([
          { kind: "text", text: scene.reply },
          expect.objectContaining({
            kind: "image",
            artifactId: image.artifactId,
            mimeType: "image/png",
            name: scene.file,
          }),
        ]);
        expect(
          (await db.thread.findUniqueOrThrow({ where: { id: nina.threadId } })).roleplayState,
        ).toMatchObject({
          turnCount: index + 2,
          media: {
            storyMode: true,
            scene: scene.scene,
            turn: index + 2,
            lastImageTurn: index + 2,
            sentImageIds: ["forest", ...laterScenes.slice(0, index + 1).map((entry) => entry.id)],
          },
        });
        const content = await rpc<RpcOutput<"artifacts/get">>(
          handles.app,
          cookie,
          "artifacts/get",
          { botId: nina.id, artifactId: image.artifactId },
        );
        expect(content.mimeType).toBe("image/png");
        expect(Buffer.from(content.contentBase64, "base64")).toEqual(
          await readFile(
            new URL(`../../../examples/roleplay/nina-story/${scene.file}`, import.meta.url),
          ),
        );
      }
      const finalScene = laterScenes[1]!.scene;
      const activeMedia = await rpc<RpcOutput<"bots/roleplayMedia">>(
        handles.app,
        cookie,
        "bots/roleplayMedia",
        { botId: nina.id },
      );
      expect(activeMedia).toMatchObject({ storyMode: true, scene: finalScene });
      const pausedMedia = await rpc<RpcOutput<"bots/updateRoleplayStoryMode">>(
        handles.app,
        cookie,
        "bots/updateRoleplayStoryMode",
        {
          botId: nina.id,
          enabled: false,
          historyGeneration: activeMedia.historyGeneration,
          expectedRevision: activeMedia.revision,
        },
      );
      expect(pausedMedia).toMatchObject({ storyMode: false, scene: finalScene });
      expect(pausedMedia.revision).not.toBe(activeMedia.revision);
      const resumedMedia = await rpc<RpcOutput<"bots/updateRoleplayStoryMode">>(
        handles.app,
        cookie,
        "bots/updateRoleplayStoryMode",
        {
          botId: nina.id,
          enabled: true,
          historyGeneration: pausedMedia.historyGeneration,
          expectedRevision: pausedMedia.revision,
        },
      );
      expect(resumedMedia).toMatchObject({ storyMode: true, scene: finalScene });
      const repeated = await send(nina, "Mostrami di nuovo la prima immagine.");
      await wait(repeated.runId);
      const repeatedThread = await rpc<RpcOutput<"threads/get">>(
        handles.app,
        cookie,
        "threads/get",
        { botId: nina.id },
      );
      expect(repeatedThread.messages.at(-1)?.blocks).toEqual([
        { kind: "text", text: "Ecco di nuovo Nina e Tilla nel bosco." },
        expect.objectContaining({
          kind: "image",
          artifactId: forest.artifactId,
          mimeType: "image/png",
        }),
      ]);
      expect(
        repeatedThread.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.kind === "image"),
      ).toHaveLength(4);
      const visibleText = repeatedThread.messages
        .flatMap((message) =>
          message.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])),
        )
        .join("\n");
      for (const hidden of [
        '"storyMode"',
        '"imageId"',
        '"imageRequested"',
        "Roleplay direction rubric v1",
      ])
        expect(visibleText).not.toContain(hidden);
      expect(
        (await db.thread.findUniqueOrThrow({ where: { id: nina.threadId } })).roleplayState,
      ).toMatchObject({
        turnCount: 4,
        media: {
          storyMode: true,
          scene: finalScene,
          sentImageIds: ["forest", "bridge", "homecoming"],
          lastImageTurn: 4,
          turn: 4,
        },
      });
      model.assertComplete();
    } finally {
      queueRelease.resolve();
      const cleanup = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      // Stop background work before deleting only this fixture's computers and identity.
      await cleanup(handles.stop);
      const computers = await db.computer
        .findMany({
          where: { bots: { some: { id: { in: bots.map((bot) => bot.id) } } } },
        })
        .catch((error: unknown) => {
          failures.push(error);
          return [];
        });
      for (const computer of computers) {
        if (computer.providerRef)
          await cleanup(async () => {
            const inspect = JSON.parse(
              execFileSync("docker", ["inspect", computer.providerRef!], { encoding: "utf8" }),
            )[0];
            const networks = Object.keys(inspect.NetworkSettings.Networks).filter((name) =>
              name.startsWith("rakazo-computer-"),
            );
            await sandbox.destroy(
              {
                id: computer.providerRef,
                providerRef: computer.providerRef,
                botId: computer.homeKey,
                kind: "docker",
              },
              {
                operationId: "roleplay-fixture-cleanup",
                traceId: "roleplay-fixture-cleanup",
                spaceId: computer.spaceId,
                userId: identity?.userId ?? "fixture",
                botId: computer.homeKey,
                signal: AbortSignal.timeout(30_000),
              },
            );
            expect(() =>
              execFileSync("docker", ["inspect", computer.providerRef!], { stdio: "pipe" }),
            ).toThrow();
            for (const network of networks)
              expect(() =>
                execFileSync("docker", ["network", "inspect", network], { stdio: "pipe" }),
              ).toThrow();
          });
      }
      if (identity?.spaceId && identity.userId) {
        await cleanup(() => db.organization.deleteMany({ where: { id: identity!.spaceId } }));
        await cleanup(() => db.user.deleteMany({ where: { id: identity!.userId } }));
      }
      await cleanup(model.close);
      await cleanup(() => fixtureDb.prisma.$disconnect());
      await cleanup(() => fixtureDb.pool.end());
      await cleanup(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
      await cleanup(() => rm(dataDir, { recursive: true, force: true }));
      vi.unstubAllEnvs();
    }
    expect(failures, "Roleplay fixture cleanup failed").toEqual([]);
  }, 240_000);
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T };
  if (!response.ok) throw new Error(`${procedure}: ${response.status} ${JSON.stringify(body)}`);
  return body.json as T;
}
