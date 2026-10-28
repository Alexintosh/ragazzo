import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NativeToolResponse, NativeToolSpec } from "./native-tool-bridge.js";

/** Run-scoped MCP endpoint. Capability URL and credential stay on the authorized host. */
export class NativeMcpServer {
  private server?: Server;
  private closed = false;
  private readonly acceptedReplies = new Map<string, string>();
  private readonly secret = randomBytes(32).toString("hex");
  private readonly pending = new Map<
    string,
    {
      resolve: (value: NativeToolResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly calls = new Map<
    string,
    { signature: string; response: Promise<NativeToolResponse> }
  >();
  constructor(
    private readonly tools: NativeToolSpec[],
    private readonly call: (id: string, tool: string, args: Record<string, unknown>) => void,
  ) {}
  async start() {
    this.server = createServer(async (request, response) => {
      const received = Buffer.from(request.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${this.secret}`);
      if (
        request.headers.origin ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        response.writeHead(401).end();
        return;
      }
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      try {
        let size = 0;
        const parts: Buffer[] = [];
        for await (const part of request) {
          size += part.length;
          if (size > 1024 * 1024) throw new Error("MCP request too large");
          parts.push(part);
        }
        const message = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP envelope");
        if (
          message.id !== undefined &&
          !(typeof message.id === "string" && message.id.length <= 256) &&
          !(typeof message.id === "number" && Number.isFinite(message.id))
        )
          throw new Error("Invalid MCP request identity");
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (message.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "rakazo", version: "0.1.0" },
            capabilities: { tools: {} },
          };
        else if (message.method === "tools/list") result = { tools: this.tools };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/call") {
          const args = message.params?.arguments === undefined ? {} : message.params.arguments;
          if (
            !this.tools.some((tool) => tool.name === message.params?.name) ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args)
          )
            throw new Error("Invalid MCP tool call");
          const identity = JSON.stringify(message.id);
          const signature = JSON.stringify([message.params.name, args]);
          let existing = this.calls.get(identity);
          if (existing && existing.signature !== signature)
            throw new Error("MCP request identity changed");
          if (!existing) {
            if (this.pending.size >= 20) throw new Error("MCP pending tool call limit exceeded");
            if (this.calls.size >= 256) throw new Error("MCP tool call limit exceeded");
            const callId = randomUUID();
            const response = new Promise<NativeToolResponse>((resolve, reject) => {
              const timer = setTimeout(() => {
                this.pending.delete(callId);
                reject(new Error("MCP tool expired"));
              }, 30 * 60_000);
              timer.unref();
              this.pending.set(callId, { resolve, reject, timer });
              this.call(callId, message.params.name, args);
            });
            existing = { signature, response };
            this.calls.set(identity, existing);
          }
          const output = await existing.response;
          result = {
            isError: !output.success,
            content: output.contentItems.map((item) => {
              if (item.type === "inputText") return { type: "text", text: item.text };
              const match = /^data:([^;]+);base64,(.*)$/.exec(item.imageUrl);
              return match
                ? { type: "image", mimeType: match[1], data: match[2] }
                : { type: "text", text: "Image output unavailable" };
            }),
          };
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unsupported MCP method" },
            }),
          );
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      } catch {
        if (!response.destroyed) response.writeHead(400).end();
      }
    });
    this.server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("MCP listener unavailable");
    return {
      type: "http" as const,
      name: "rakazo",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${this.secret}` }],
    };
  }
  reply(id: string | number, value: NativeToolResponse) {
    if (this.closed) throw new Error("MCP run revoked");
    const signature = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const accepted = this.acceptedReplies.get(String(id));
    if (accepted !== undefined) {
      if (accepted !== signature) throw new Error("MCP result already answered");
      return;
    }
    const call = this.pending.get(String(id));
    if (!call) throw new Error("MCP result binding mismatch");
    // The request ledger bounds these signatures to 256 entries for this run.
    this.acceptedReplies.set(String(id), signature);
    this.pending.delete(String(id));
    clearTimeout(call.timer);
    call.resolve(value);
  }
  close() {
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("MCP run revoked"));
    }
    this.pending.clear();
    this.acceptedReplies.clear();
    this.calls.clear();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
