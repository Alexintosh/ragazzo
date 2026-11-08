import type { AdapterContext, ComputerRef, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostComputerTransport } from "./registered-hosts.js";

const context: AdapterContext = {
  operationId: "browser",
  traceId: "browser",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "computer",
  botId: "team-home",
  kind: "desktop",
  providerRef: "host:team-home",
  scope: "team",
  registeredHostId: "registered",
};
function fixture(local = false) {
  const findComputer = vi.fn(async () => ({
    id: "computer",
    scope: "team",
    registeredHostId: local ? null : "registered",
  }));
  const botCount = vi.fn(async () => 1);
  const controlCount = vi.fn(async () => 1);
  const hostCount = vi.fn(async () => 1);
  const findHost = vi.fn(async () => ({
    id: "registered",
    endpoint: "https://host.example.test",
    ciphertext: "sealed",
    revokedAt: null,
  }));
  const load = vi.fn(async () => "host-secret");
  const fetch = vi.fn(
    async () =>
      new Response(
        `${JSON.stringify({ value: { ok: true, title: "Fixture" } })}\n${JSON.stringify({ done: true })}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const client = createHostComputerTransport({
    prisma: {
      computer: { findFirst: findComputer, count: controlCount },
      bot: { count: botCount },
      registeredHost: { findFirst: findHost, count: hostCount },
    } as unknown as PrismaClient,
    secrets: { load } as unknown as SecretStore,
    hostComputerUrl: "http://127.0.0.1:9876",
    hostComputerToken: "local-secret",
  });
  return { client, findComputer, botCount, controlCount, hostCount, findHost, fetch, load };
}
afterEach(() => vi.unstubAllGlobals());
describe("host browser registered transport authority", () => {
  it("preserves tenant and acting bot scope and uses only the registered endpoint/secret", async () => {
    const f = fixture();
    await f.client.pageBrowser(computer, { command: "snapshot" }, context);
    expect(f.findComputer).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { homeKey: "team-home", spaceId: "space", userId: "owner" },
      }),
    );
    expect(f.botCount).toHaveBeenCalledWith({
      where: {
        id: "bot",
        spaceId: "space",
        userId: "owner",
        computerId: "computer",
        archivedAt: null,
      },
    });
    const [url, request] = f.fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://host.example.test");
    expect(JSON.parse(String(request.body))).toMatchObject({
      method: "browserPage",
      botId: "team-home",
      scope: {
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        mode: "team",
        registrationId: "registered",
      },
    });
  });
  it("checks local host ownership too", async () => {
    const f = fixture(true);
    await f.client.pageBrowser(
      { ...computer, registeredHostId: null },
      { command: "snapshot" },
      context,
    );
    expect(f.botCount).toHaveBeenCalled();
    expect(f.findHost).not.toHaveBeenCalled();
    expect((f.fetch.mock.calls[0]! as unknown as [URL])[0].origin).toBe("http://127.0.0.1:9876");
  });
  it("rejects a bot that changed computers before loading the host credential", async () => {
    const f = fixture();
    f.botCount.mockResolvedValue(0);
    await expect(f.client.pageBrowser(computer, { command: "snapshot" }, context)).rejects.toThrow(
      "placement changed",
    );
    expect(f.load).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([{ scope: "dedicated" as const }, { registeredHostId: "different-registration" }])(
    "rejects stale placement %j",
    async (patch) => {
      const f = fixture();
      await expect(
        f.client.pageBrowser({ ...computer, ...patch }, { command: "snapshot" }, context),
      ).rejects.toThrow("computer is unavailable");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("checks a live control lease before issuing an interactive viewer", async () => {
    const f = fixture();
    f.controlCount.mockResolvedValue(0);
    await expect(
      f.client.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "old-lease" },
        context,
      ),
    ).rejects.toThrow("lease changed");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rechecks ownership after slow secret resolution and before sending a browser request", async () => {
    const f = fixture();
    f.load.mockImplementationOnce(async () => {
      f.botCount.mockResolvedValue(0);
      return "host-secret";
    });
    await expect(f.client.pageBrowser(computer, { command: "snapshot" }, context)).rejects.toThrow(
      "placement changed",
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not expose the private revocation transport through regular host resolution", async () => {
    const f = fixture();
    const call = async () => {
      for await (const _ of f.client.request(
        {
          method: "browserRevokeScope",
          botId: "setup",
          scope: { spaceId: "space", userId: "owner", registrationId: "registered" },
        },
        context,
      )) {
      }
    };
    await expect(call()).rejects.toThrow("private cleanup transport");
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
