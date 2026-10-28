import { existsSync } from "node:fs";
import { startHostComputerServer } from "@rakazo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkNativeDockerSupervisor,
  checkNativeHostDefault,
  nativeStackSettings,
  startNativeStack,
} from "./native-stack.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  existsSync: vi.fn(),
}));
vi.mock("@rakazo/adapters", () => ({ startHostComputerServer: vi.fn() }));
const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
  disconnect: vi.fn(),
  end: vi.fn(),
}));
vi.mock("@rakazo/db", () => ({
  createDb: () => ({
    prisma: {
      deploymentSettings: { findUnique: database.findUnique },
      $disconnect: database.disconnect,
    },
    pool: { end: database.end },
  }),
  runAsSystem: (_reason: string, work: () => unknown) => work(),
}));
beforeEach(() => vi.clearAllMocks());

const env = {
  DATABASE_URL: "postgres://test:test@127.0.0.1/test",
  ENCRYPTION_KEY: "test-only",
  BETTER_AUTH_SECRET: "test-only",
  SCREEN_PROXY_SECRET: "test-only",
};
describe("standalone native stack", () => {
  it("requires explicit local consent and preexisting PostgreSQL/secrets", () => {
    expect(() => nativeStackSettings(env, "/project", false)).toThrow("--allow-host");
    expect(() => nativeStackSettings({}, "/project", true)).toThrow("DATABASE_URL");
    expect(() => nativeStackSettings({ DATABASE_URL: env.DATABASE_URL }, "/project", true)).toThrow(
      "ENCRYPTION_KEY",
    );
  });
  it("pins local listeners and uses durable queue plus authenticated host placement", () => {
    const settings = nativeStackSettings(
      {
        ...env,
        API_HOST: "0.0.0.0",
        WEB_ORIGIN: "https://other.example",
        WAKEUP_DRIVER: "memory",
        SANDBOX_PROVIDER: "docker",
        DATA_DIR: "state",
        API_PORT: "3110",
        WEB_PORT: "5180",
      },
      "/project",
      true,
    );
    expect(settings.dataDir).toBe("/project/state");
    expect(settings.env).toMatchObject({
      SANDBOX_PROVIDER: "desktop",
      WAKEUP_DRIVER: "graphile",
      API_HOST: "127.0.0.1",
      WEB_ORIGIN: "http://127.0.0.1:5180",
      API_PROXY_TARGET: "http://127.0.0.1:3110",
      DATABASE_URL: env.DATABASE_URL,
    });
    expect(settings.env).not.toHaveProperty("SANDBOX_HOST_TOKEN");
  });
  it.each(["NaN", "0", "-1", "1.5", "65536"])("rejects invalid listener port %s", (API_PORT) => {
    expect(() => nativeStackSettings({ ...env, API_PORT }, "/project", true)).toThrow("API_PORT");
  });
  it("refuses colliding listeners", () => {
    expect(() =>
      nativeStackSettings({ ...env, API_PORT: "5180", WEB_PORT: "5180" }, "/project", true),
    ).toThrow("must differ");
  });
  it("requires an existing explicitly configured supervisor for Docker opt-in", () => {
    expect(() => nativeStackSettings(env, "/project", true, true)).toThrow("--with-docker");
    const dockerEnv = {
      ...env,
      SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
      SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
    };
    expect(nativeStackSettings(dockerEnv, "/project", true).env.SANDBOX_PROVIDER).toBe("desktop");
    expect(nativeStackSettings(dockerEnv, "/project", true, true).env.SANDBOX_PROVIDER).toBe(
      "docker",
    );
    expect(() =>
      nativeStackSettings(
        { ...dockerEnv, SANDBOX_SUPERVISOR_URL: "file:///tmp/supervisor" },
        "/project",
        true,
        true,
      ),
    ).toThrow("HTTP(S)");
    expect(() =>
      nativeStackSettings(
        { ...dockerEnv, SANDBOX_SUPERVISOR_TOKEN: "short" },
        "/project",
        true,
        true,
      ),
    ).toThrow("at least 32 characters");
  });
  it("checks authenticated image readiness without provisioning", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, image: "rakazo/computer:local" }));
    await checkNativeDockerSupervisor(
      {
        SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091/",
        SANDBOX_SUPERVISOR_TOKEN: "test-token",
      },
      request,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:7091/readiness",
      expect.objectContaining({
        headers: { authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
  });
  it.each([
    () => Response.json({ ok: false }, { status: 503 }),
    () => Response.json({ ok: true }),
    () => Response.json({ error: "unauthorized" }, { status: 401 }),
    () => {
      throw new Error("unreachable");
    },
  ])(
    "refuses Docker when supervisor or image readiness cannot be established",
    async (response) => {
      const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(
        checkNativeDockerSupervisor(
          {
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "test-token",
          },
          request,
        ),
      ).rejects.toThrow("Docker sandbox is unavailable");
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it("fails Docker preflight before opening the host bridge or launching services", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: false }, { status: 503 })),
    );
    try {
      await expect(
        startNativeStack(
          "/project",
          {
            ...env,
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
          },
          true,
          true,
        ),
      ).rejects.toThrow("Docker sandbox is unavailable");
      expect(startHostComputerServer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads only the host default preference and closes its database connections", async () => {
    database.findUnique.mockResolvedValueOnce({ computerHost: "this-mac" });
    await expect(checkNativeHostDefault(env)).resolves.toBeUndefined();
    expect(database.findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { computerHost: true },
    });
    expect(database.disconnect).toHaveBeenCalledOnce();
    expect(database.end).toHaveBeenCalledOnce();
  });
  it.each([null, "docker"])(
    "refuses to move existing host defaults when preference is %s",
    async (computerHost) => {
      database.findUnique.mockResolvedValueOnce({ computerHost });
      await expect(checkNativeHostDefault(env)).rejects.toThrow(
        "explicitly set the deployment computer preference to this-mac",
      );
      expect(database.disconnect).toHaveBeenCalledOnce();
      expect(database.end).toHaveBeenCalledOnce();
    },
  );
  it("rejects an unset default before opening host access", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    database.findUnique.mockResolvedValueOnce({ computerHost: null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true, image: "installed" })),
    );
    try {
      await expect(
        startNativeStack(
          "/project",
          {
            ...env,
            SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
            SANDBOX_SUPERVISOR_TOKEN: "s".repeat(40),
          },
          true,
          true,
        ),
      ).rejects.toThrow("explicitly set the deployment computer preference");
      expect(startHostComputerServer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
