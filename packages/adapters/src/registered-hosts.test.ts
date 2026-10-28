import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostComputerTransport, registeredHostEndpoint } from "./registered-hosts.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  runId: "run",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
function fixture() {
  const run: { nativeHostId: string | null; nativeComputerId: string | null } = {
    nativeHostId: "original",
    nativeComputerId: "computer",
  };
  const computer = { registeredHostId: "original", homeKey: "key" };
  const host = {
    id: "original",
    endpoint: "https://original.example.test",
    ciphertext: "encrypted",
  };
  const prisma = {
    run: { findFirst: vi.fn(async () => run) },
    computerExecutionLease: { findFirst: vi.fn(async () => ({ computerId: "leased-computer" })) },
    computer: { findFirst: vi.fn(async () => computer) },
    bot: { findFirst: vi.fn(async () => ({ registeredHostId: "changed-bot-setting" })) },
    registeredHost: { findFirst: vi.fn(async () => host), count: vi.fn(async () => 1) },
  };
  const secrets = { load: vi.fn(async () => "secret") };
  const fetcher = vi.fn(
    async () => new Response('{"value":{"cleanupVerified":true}}\n{"done":true}\n'),
  );
  vi.stubGlobal("fetch", fetcher);
  return {
    prisma,
    secrets,
    fetcher,
    run,
    computer,
    host,
    transport: createHostComputerTransport({
      prisma: prisma as unknown as PrismaClient,
      secrets: secrets as unknown as SecretStore,
      hostComputerUrl: "https://global.example.test",
      hostComputerToken: "global-secret",
    }),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("registered host identity and credentials", () => {
  it.each([
    "https://user:pass@host.test",
    "https://host.test/path",
    "https://host.test?token=x",
    "https://host.test/#x",
    "http://remote.test",
    "http://169.254.169.254",
    "https://metadata.google.internal",
  ])("rejects unsafe origin %s", (endpoint) => {
    expect(() => registeredHostEndpoint(endpoint)).toThrow();
  });
  it("permits TLS hosts and explicit loopback hosts", () => {
    expect(registeredHostEndpoint("https://host.example.test/")).toBe("https://host.example.test");
    expect(registeredHostEndpoint("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  });
  it("binds model discovery to the owned bot's selected host without requiring a run", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValue({
      registeredHostId: "original",
      runtimeKind: "codex",
      projectPath: "/project",
    } as never);
    for await (const _ of f.transport.request(
      {
        method: "codexModels",
        botId: "bot",
        threadId: "thread",
        runId: "discovery",
        projectPath: "/project",
      },
      { ...context, runId: undefined },
    )) {
    }
    expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot", spaceId: "space", userId: "owner" } }),
    );
    expect(f.prisma.registeredHost.findFirst).toHaveBeenCalledWith({
      where: { id: "original", spaceId: "space", userId: "owner" },
    });
    expect(f.fetcher).toHaveBeenCalledWith(
      new URL("https://original.example.test/computer"),
      expect.anything(),
    );
    f.prisma.bot.findFirst.mockResolvedValue({
      registeredHostId: "original",
      runtimeKind: "claude",
    } as never);
    await expect(async () => {
      for await (const _ of f.transport.request(
        {
          method: "codexModels",
          botId: "bot",
          threadId: "thread",
          runId: "discovery",
          projectPath: "/project",
        },
        context,
      )) {
      }
    }).rejects.toThrow("runtime identity changed");
  });
  it("routes native resume and stop by the pinned run, never current bot or global host", async () => {
    const f = fixture();
    for await (const _ of f.transport.request(
      { method: "codexAbort", botId: "bot", threadId: "thread", runId: "original-run" },
      context,
    )) {
      /* drain */
    }
    expect(f.prisma.run.findFirst).toHaveBeenCalledWith({
      where: { id: "run", spaceId: "space", userId: "owner" },
      select: expect.anything(),
    });
    expect(f.prisma.bot.findFirst).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledWith(
      new URL("https://original.example.test/computer"),
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
    expect(f.secrets.load).toHaveBeenCalledWith("encrypted", "original");
  });
  it("refuses a run whose original computer now points to a different host", async () => {
    const f = fixture();
    f.computer.registeredHostId = "replacement";
    await expect(async () => {
      for await (const _ of f.transport.request(
        { method: "codexAbort", botId: "bot", threadId: "thread", runId: "run" },
        context,
      )) {
        /* drain */
      }
    }).rejects.toThrow("identity changed");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("revocation fails closed without falling back to the global host", async () => {
    const f = fixture();
    f.prisma.registeredHost.findFirst.mockResolvedValue(null as never);
    await expect(
      f.transport.isRunning(
        { id: "c", botId: "key", kind: "desktop", providerRef: "ref" },
        context,
      ),
    ).rejects.toThrow("revoked or unavailable");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.prisma.computer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { homeKey: "key", spaceId: "space", userId: "owner" } }),
    );
  });
  it("checks revocation again after deferred credential loading before dispatch", async () => {
    const f = fixture();
    let release!: (token: string) => void;
    const waiting = new Promise<string>((resolve) => {
      release = resolve;
    });
    f.secrets.load.mockReturnValueOnce(waiting);
    const request = f.transport.isRunning(
      { id: "c", botId: "key", kind: "desktop", providerRef: "ref" },
      context,
    );
    const rejected = expect(request).rejects.toThrow("revoked");
    await vi.waitFor(() => expect(f.secrets.load).toHaveBeenCalledOnce());
    f.prisma.registeredHost.count.mockResolvedValue(0);
    release("secret");
    await rejected;
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("revokes a live stream even while the host is quiet", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.prisma.registeredHost.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    f.fetcher.mockImplementation(async () => new Response(new ReadableStream()));
    const drain = (async () => {
      for await (const _ of f.transport.request(
        { method: "codexAbort", botId: "bot", threadId: "thread", runId: "run" },
        context,
      )) {
        /* drain */
      }
    })();
    const rejected = expect(drain).rejects.toThrow("revoked or unavailable");
    await vi.advanceTimersByTimeAsync(1100);
    await rejected;
  });
  it("authorizes strict Pi cleanup through its persisted source-run computer lease", async () => {
    const f = fixture();
    f.run.nativeComputerId = null;
    f.run.nativeHostId = null;
    await f.transport.cancelRunWork(
      { id: "c", botId: "key", kind: "desktop", providerRef: "ref" },
      "c",
      "run",
      { ...context, requireRunCleanup: true },
    );
    expect(f.prisma.computerExecutionLease.findFirst).toHaveBeenCalledWith({
      where: { runId: "run" },
      select: { computerId: true },
    });
    expect(f.prisma.computer.findFirst).toHaveBeenCalledWith({
      where: { id: "leased-computer", spaceId: "space", userId: "owner" },
    });
  });
  it("binds native-only retirement to the pinned original computer and host", async () => {
    const f = fixture();
    for await (const _ of f.transport.request(
      {
        method: "codexRetire",
        botId: "bot",
        threadId: "thread",
        runId: "physical-run",
        computerKey: "key",
      },
      context,
    )) {
    }
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.prisma.bot.findFirst).not.toHaveBeenCalled();
    await expect(async () => {
      for await (const _ of f.transport.request(
        {
          method: "codexRetire",
          botId: "bot",
          threadId: "thread",
          runId: "physical-run",
          computerKey: "other-computer",
        },
        context,
      )) {
      }
    }).rejects.toThrow("identity changed");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("rejects application-owner impersonation before dispatching a handover child", async () => {
    const f = fixture();
    await expect(async () => {
      for await (const _ of f.transport.request(
        {
          method: "codexRunContextScoped",
          botId: "bot",
          threadId: "thread",
          runId: "physical-run",
          prompt: "task",
          instructions: "instructions",
          model: "default",
          after: 0,
          config: {
            computerKey: "key",
            permission: "workspace",
            projectPath: "/project",
            historyGeneration: 0,
            contextScope: "scope",
            applicationRunId: "someone-elses-run",
          },
        },
        context,
      )) {
      }
    }).rejects.toThrow("owner binding mismatch");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.prisma.run.findFirst).not.toHaveBeenCalled();
  });
});
