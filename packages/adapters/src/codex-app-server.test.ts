import { describe, expect, it, vi } from "vitest";
import type { CodexClient } from "./codex-app-server.js";
import { initializeCodex, nativeCodexThreadConfig } from "./codex-app-server.js";

function client(result: unknown): CodexClient {
  return {
    request: vi.fn(async () => result),
    reply: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
  };
}

describe("native Codex configuration", () => {
  it("negotiates the API required to clean owned background terminals", async () => {
    const rpc = client({});
    await initializeCodex(rpc);
    expect(rpc.request).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({
        capabilities: { experimentalApi: true },
      }),
    );
    expect(rpc.notify).toHaveBeenCalledWith("initialized");
  });

  it("disables each effective MCP server without forwarding its credentials", async () => {
    const rpc = client({
      config: {
        mcp_servers: {
          local: { command: "fixture", env: { TOKEN: "fake-secret" } },
          "server.with.dots": { url: "https://example.test", enabled: true },
          disabled: { enabled: false },
        },
        unrelated: "private-setting",
      },
    });
    expect(await nativeCodexThreadConfig(rpc, "/projects/test")).toEqual({
      mcp_servers: {
        local: { enabled: false },
        "server.with.dots": { enabled: false },
        disabled: { enabled: false },
      },
      "features.apps": false,
      "features.plugins": false,
    });
    expect(rpc.request).toHaveBeenCalledWith("config/read", {
      includeLayers: false,
      cwd: "/projects/test",
    });
  });

  it("accepts a configuration with no MCP servers", async () => {
    expect(await nativeCodexThreadConfig(client({ config: {} }), "/projects/test")).toEqual({
      mcp_servers: {},
      "features.apps": false,
      "features.plugins": false,
    });
  });

  it.each([
    {},
    null,
    { config: [] },
    { config: { mcp_servers: [] } },
    { config: { mcp_servers: "invalid" } },
  ])("rejects unreadable configuration before a thread can start: %j", async (result) => {
    await expect(nativeCodexThreadConfig(client(result), "/projects/test")).rejects.toThrow();
  });
});
