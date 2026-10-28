import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { canReleaseScreenLease, canTakeScreenLease } from "@rakazo/core";
import type { HostBrowserManager, HostBrowserScope } from "./host-browser.js";
import type { HostBrowserIdentity, HostBrowserRequest } from "./host-browser-protocol.js";
import { hostBrowserPreviewCommand } from "./host-browser-protocol.js";
import { hostBrowserViewerHtml } from "./host-browser-viewer.js";

type BrowserOwner = {
  identity: HostBrowserIdentity;
  homeKey: string;
  scope: HostBrowserScope;
  runId?: string;
  leaseId?: string;
  controlToken?: string;
  generation: number;
  revoked: boolean;
  controller: AbortController;
  botWork: AbortController;
  controlWork: AbortController;
  cleanup?: Promise<void>;
};
type Viewer = {
  owner: BrowserOwner;
  interactive: boolean;
  controlToken?: string;
  generation: number;
  expiresAt: number;
};

/** Host-only browser ownership. Every public request still traverses the sealed screen proxy. */
export class HostBrowserBridge {
  private readonly owners = new Map<string, BrowserOwner>();
  private readonly viewers = new Map<string, Viewer>();
  private closing = false;
  private suspending = 0;
  private readonly stoppedComputers = new Map<string, number>();
  private readonly revokedScopes = new Set<string>();
  constructor(private readonly manager: HostBrowserManager) {}

  private key(homeKey: string, identity: HostBrowserIdentity) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          identity.spaceId,
          identity.userId,
          identity.registrationId ?? null,
          homeKey,
          identity.botId,
        ]),
      )
      .digest("hex");
  }
  private owner(
    input: Exclude<HostBrowserRequest, { method: "browserRevokeScope" }>,
    computer: ComputerRef,
    claim: boolean,
  ) {
    if (
      this.closing ||
      this.suspending ||
      this.stoppedComputers.has(input.botId) ||
      this.revokedScopes.has(
        JSON.stringify([
          input.scope.spaceId,
          input.scope.userId,
          input.scope.registrationId ?? null,
        ]),
      ) ||
      this.revokedScopes.has(JSON.stringify([input.scope.spaceId, input.scope.userId, "*"]))
    )
      throw new Error("Host browser is stopping");
    const key = this.key(input.botId, input.scope);
    let owner = this.owners.get(key);
    if (!owner) {
      if (this.owners.size >= 32) throw new Error("Too many host browser sessions");
      const root = path.resolve(computer.providerRef);
      // Team and private computers already have distinct host-owned workspace roots.
      const workspaceRoot = root;
      const botRoot = input.scope.mode === "team" ? path.join("bots", input.scope.botId) : ".";
      owner = {
        identity: input.scope,
        homeKey: input.botId,
        scope: {
          computerId: createHash("sha256")
            .update(
              JSON.stringify([
                input.scope.spaceId,
                input.scope.userId,
                input.scope.registrationId ?? null,
                input.botId,
              ]),
            )
            .digest("hex"),
          botId: input.scope.botId,
          workspaceRoot,
          uploadRoots: input.scope.mode === "team" ? [botRoot, "shared"] : ["."],
          downloadDirectory: path.join(workspaceRoot, botRoot, "Downloads"),
        },
        generation: 0,
        revoked: false,
        controller: new AbortController(),
        botWork: new AbortController(),
        controlWork: new AbortController(),
      };
      this.owners.set(key, owner);
    }
    if (owner.revoked) throw new Error("Host browser is stopping");
    if (claim && input.runId) {
      if (owner.controlToken) throw new Error("Release browser control before running bot actions");
      if (!canTakeScreenLease(owner.leaseId, input.screenLeaseId))
        throw new Error("Browser lease changed");
      if (
        owner.runId !== input.runId ||
        (input.screenLeaseId !== undefined && owner.leaseId !== input.screenLeaseId)
      ) {
        owner.botWork.abort();
        owner.botWork = new AbortController();
      }
      owner.runId = input.runId;
      owner.leaseId = input.screenLeaseId ?? owner.leaseId;
    }
    return owner;
  }
  async dispatch(
    input: HostBrowserRequest,
    computer: ComputerRef,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (input.method === "browserRevokeScope") {
      this.revokedScopes.add(
        JSON.stringify([
          input.scope.spaceId,
          input.scope.userId,
          input.scope.registrationId ?? "*",
        ]),
      );
      await this.closeWhere(
        (owner) =>
          owner.identity.spaceId === input.scope.spaceId &&
          owner.identity.userId === input.scope.userId &&
          (!input.scope.registrationId ||
            owner.identity.registrationId === input.scope.registrationId),
      );
      return { browserCleanupVerified: true };
    }
    const claim = ["browserPage", "browserObserve", "browserAct"].includes(input.method);
    const owner = this.owner(input, computer, claim);
    const bounded = AbortSignal.any([
      signal,
      owner.controller.signal,
      ...(claim ? [owner.botWork.signal] : []),
    ]);
    switch (input.method) {
      case "browserPage":
        return this.manager.pageBrowser(owner.scope, input.command, bounded);
      case "browserObserve":
        return this.manager.screenshot(owner.scope, bounded);
      case "browserAct":
        return this.manager.computerAct(owner.scope, input.request, bounded);
      case "browserControl":
        if (input.interactive) {
          if (!input.controlToken) throw new Error("Browser control requires a lease");
          if (owner.controlToken === input.controlToken) return null;
          owner.controlWork.abort();
          owner.controlWork = new AbortController();
          owner.botWork.abort();
          owner.controlToken = input.controlToken;
          owner.generation++;
        } else if (!input.controlToken || owner.controlToken === input.controlToken) {
          owner.controlWork.abort();
          owner.controlWork = new AbortController();
          owner.botWork = new AbortController();
          owner.controlToken = undefined;
          owner.generation++;
        }
        return null;
      case "browserScreen": {
        if (input.interactive && (!input.controlToken || input.controlToken !== owner.controlToken))
          throw new Error("Browser control lease changed");
        this.pruneViewers();
        if (this.viewers.size >= 256) throw new Error("Too many browser viewers");
        const session = randomBytes(32).toString("hex");
        this.viewers.set(session, {
          owner,
          interactive: input.interactive,
          controlToken: input.controlToken,
          generation: owner.generation,
          expiresAt: Date.now() + 60 * 60_000,
        });
        return { path: `/browser-screen/${session}/embed.html` };
      }
      case "browserRelease":
        if (!canReleaseScreenLease(owner.leaseId, input.screenLeaseId)) return null;
        if (input.cancel || !input.keepWarm) await this.closeOwner(owner);
        return null;
    }
  }

  private pruneViewers() {
    for (const [key, viewer] of this.viewers)
      if (viewer.expiresAt <= Date.now() || viewer.owner.revoked) this.viewers.delete(key);
  }
  /** Called only after bearer authentication and local-consent checks by the host server. */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = request.url?.match(
      /^\/browser-screen\/([a-f0-9]{64})\/(embed\.html|frame|input)(?:\?[^#]*)?$/,
    );
    this.pruneViewers();
    const viewer = match ? this.viewers.get(match[1]!) : undefined;
    if (
      !viewer ||
      !match ||
      this.closing ||
      viewer.owner.revoked ||
      (viewer.interactive &&
        (viewer.owner.controlToken !== viewer.controlToken ||
          viewer.owner.generation !== viewer.generation))
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    const signal = AbortSignal.any([
      abort.signal,
      viewer.owner.controller.signal,
      ...(viewer.interactive ? [viewer.owner.controlWork.signal] : []),
      AbortSignal.timeout(20_000),
    ]);
    try {
      if (match[2] === "embed.html" && request.method === "GET") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src *; base-uri 'none'; form-action 'none'; frame-ancestors *",
        );
        response.end(hostBrowserViewerHtml(viewer.interactive));
        return;
      }
      if (match[2] === "frame" && request.method === "GET") {
        const result = await this.manager.preview(viewer.owner.scope, { action: "state" }, signal);
        signal.throwIfAborted();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
        return;
      }
      if (
        match[2] !== "input" ||
        request.method !== "POST" ||
        !viewer.interactive ||
        !/^(text\/plain|application\/json)(?:;|$)/i.test(request.headers["content-type"] ?? "")
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const command = hostBrowserPreviewCommand.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      // Recheck after reading the body; control can change while the sender is streaming it.
      if (
        viewer.owner.controlToken !== viewer.controlToken ||
        viewer.owner.generation !== viewer.generation
      )
        throw new Error("Browser control lease changed");
      signal.throwIfAborted();
      const result = await this.manager.preview(viewer.owner.scope, command, signal);
      signal.throwIfAborted();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    } catch {
      if (!response.headersSent) response.writeHead(409);
      if (!response.destroyed) response.end("Browser unavailable. Refresh the preview.");
    }
  }
  private async closeOwner(owner: BrowserOwner) {
    if (owner.cleanup) return owner.cleanup;
    owner.revoked = true;
    owner.controller.abort();
    for (const [key, viewer] of this.viewers) if (viewer.owner === owner) this.viewers.delete(key);
    const cleanup = (async () => {
      await this.manager.stop(owner.scope);
      for (const [key, value] of this.owners) if (value === owner) this.owners.delete(key);
    })();
    owner.cleanup = cleanup;
    try {
      await cleanup;
    } catch (error) {
      owner.cleanup = undefined;
      throw error;
    }
  }
  private async closeWhere(predicate: (owner: BrowserOwner) => boolean) {
    const results = await Promise.allSettled(
      [...this.owners.values()].filter(predicate).map((owner) => this.closeOwner(owner)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  cancelRun(homeKey: string, runIds: string[]) {
    return this.closeWhere(
      (owner) => owner.homeKey === homeKey && !!owner.runId && runIds.includes(owner.runId),
    );
  }
  stopComputer(homeKey: string) {
    return this.closeWhere((owner) => owner.homeKey === homeKey);
  }
  beginComputerStop(homeKey: string) {
    this.stoppedComputers.set(homeKey, (this.stoppedComputers.get(homeKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.stoppedComputers.get(homeKey) ?? 1) - 1;
      if (count) this.stoppedComputers.set(homeKey, count);
      else this.stoppedComputers.delete(homeKey);
    };
  }
  async stopAll() {
    this.suspending++;
    try {
      await this.closeWhere(() => true);
    } finally {
      this.suspending--;
    }
  }
  async close() {
    this.closing = true;
    await this.closeWhere(() => true);
    await this.manager.close();
  }
}
