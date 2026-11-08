import { describe, expect, it } from "vitest";
import { NativeMcpServer } from "./native-mcp-server.js";
import type { NativeToolResponse } from "./native-tool-bridge.js";

describe("run-scoped native MCP boundary", () => {
  it("normalizes omitted arguments and acknowledges only identical accepted result retries", async () => {
    const value: NativeToolResponse = {
      success: true,
      contentItems: [{ type: "inputText", text: "result" }],
    };
    const calls: Array<{ id: string; args: Record<string, unknown> }> = [];
    const server = new NativeMcpServer(
      [{ name: "effect", description: "Fixture", inputSchema: { type: "object" } }],
      (id, _tool, args) => {
        calls.push({ id, args });
        server.reply(id, value);
      },
    );
    const connection = await server.start();
    const headers = {
      ...Object.fromEntries(connection.headers.map((header) => [header.name, header.value])),
      "content-type": "application/json",
    };
    const request = (id: number, params: Record<string, unknown>) =>
      fetch(connection.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }),
      });
    try {
      const first = await request(1, { name: "effect" });
      expect(first.status).toBe(200);
      const output = await first.json();
      expect(output.result.content).toEqual([{ type: "text", text: "result" }]);
      expect(calls).toEqual([{ id: expect.any(String), args: {} }]);
      expect(await (await request(1, { name: "effect", arguments: {} })).json()).toEqual(output);
      expect(calls).toHaveLength(1);
      expect(() => server.reply(calls[0]!.id, structuredClone(value))).not.toThrow();
      expect(() => server.reply(calls[0]!.id, { ...value, success: false })).toThrow(
        "already answered",
      );
      for (const args of [null, []])
        expect((await request(2, { name: "effect", arguments: args })).status).toBe(400);
      expect((await request(1, { name: "effect", arguments: { changed: true } })).status).toBe(400);
      expect(calls).toHaveLength(1);
    } finally {
      server.close();
    }
    expect(() => server.reply(calls[0]!.id, value)).toThrow("revoked");
  });
  it("requires its private capability, rejects browser origins, and executes duplicate requests once", async () => {
    let calls = 0;
    const server = new NativeMcpServer(
      [{ name: "effect", description: "Fixture", inputSchema: { type: "object" } }],
      (id) => {
        calls++;
        setTimeout(
          () =>
            server.reply(id, {
              success: true,
              contentItems: [{ type: "inputText", text: "result" }],
            }),
          10,
        );
      },
    );
    const connection = await server.start();
    const headers = {
      ...Object.fromEntries(connection.headers.map((header) => [header.name, header.value])),
      "content-type": "application/json",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "effect", arguments: { value: 1 } },
    });
    try {
      expect(
        (
          await fetch(connection.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(connection.url, {
            method: "POST",
            headers: { ...headers, origin: "https://example.invalid" },
            body,
          })
        ).status,
      ).toBe(401);
      const [first, duplicate] = await Promise.all([
        fetch(connection.url, { method: "POST", headers, body }).then((r) => r.json()),
        fetch(connection.url, { method: "POST", headers, body }).then((r) => r.json()),
      ]);
      expect(first).toEqual(duplicate);
      expect(calls).toBe(1);
      expect(
        (
          await fetch(connection.url, {
            method: "POST",
            headers,
            body: body.replace('"value":1', '"value":2'),
          })
        ).status,
      ).toBe(400);
    } finally {
      server.close();
    }
  });
});
