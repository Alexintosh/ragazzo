import { createHash } from "node:crypto";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { clipToolResultText } from "./pi-runtime-limits.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";
import { namedAgentTools, serializeToolResult } from "./pi-runtime-tools.js";
import { toolCompletionFromResult } from "./tool-completion-audit.js";

export interface NativeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface NativeToolCall {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  executionId: string;
}
export interface NativeToolResponse {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
}
// These names are implemented by Pi's orchestration callbacks, not applyTool.
// Native providers retain their own question flow; never advertise nonfunctional stubs.
const runtimeOwnedTools = new Set(["run_subagent", "ask_user", "request_takeover"]);

/** Provider-neutral catalog and dispatch boundary. Execution still belongs to the run's gate. */
export class NativeToolBridge {
  private readonly tools: Map<string, { tool: ConnectorTool; schema: Record<string, unknown> }>;
  readonly catalog: NativeToolSpec[];
  readonly fingerprint: string;
  constructor(private readonly request: AgentRunRequest) {
    const named = namedAgentTools(
      request.tools.filter((tool) => !runtimeOwnedTools.has(tool.name)),
    );
    this.tools = new Map(
      named.map(({ name, tool }) => [
        name,
        {
          tool,
          schema: JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>,
        },
      ]),
    );
    this.catalog = [...this.tools].map(([name, { tool, schema }]) => ({
      name,
      description: tool.description,
      inputSchema: schema,
    }));
    // Routes and declared effects are bound too, even though they never cross the host boundary.
    this.fingerprint = createHash("sha256")
      .update(JSON.stringify([named, this.catalog]))
      .digest("hex");
  }
  has(name: string) {
    return this.tools.has(name);
  }
  async execute(
    call: NativeToolCall,
    signal: AbortSignal,
  ): Promise<{ paused: true } | { paused: false; response: NativeToolResponse }> {
    signal.throwIfAborted();
    const entry = this.tools.get(call.tool);
    if (!entry || !this.request.executeTool)
      throw new Error("Native application tool is unavailable");
    const started = Date.now();
    let result: unknown;
    try {
      const args = parseConnectorToolArgs(entry.schema, call.arguments);
      signal.throwIfAborted();
      result = await this.request.executeTool(
        entry.tool.name,
        args,
        call.executionId,
        entry.tool.route,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      result = { error: sanitizeConnectorError(error, []) };
    }
    signal.throwIfAborted();
    await this.request.onToolCompleted?.(
      toolCompletionFromResult(
        {
          name: entry.tool.name,
          executionId: call.executionId,
          durationMs: Date.now() - started,
        },
        result,
      ),
    );
    if (isToolPauseResult(result)) return { paused: true };
    const record =
      result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    const contentItems: NativeToolResponse["contentItems"] = [];
    let imageBytes = 0;
    if (record?.kind === "agent_tool_result" && Array.isArray(record.content)) {
      let remaining = 12_000;
      for (const part of record.content) {
        if (contentItems.length >= 128) break;
        if (part?.type === "text" && typeof part.text === "string" && remaining > 0) {
          contentItems.push({ type: "inputText", text: clipToolResultText(part.text, remaining) });
          remaining -= part.text.length;
        } else if (
          part?.type === "image" &&
          typeof part.data === "string" &&
          /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType) &&
          /^[A-Za-z0-9+/]+=*$/.test(part.data) &&
          imageBytes + part.data.length <= 8 * 1024 * 1024
        ) {
          imageBytes += part.data.length;
          contentItems.push({
            type: "inputImage",
            imageUrl: `data:${part.mimeType};base64,${part.data}`,
          });
        }
      }
    } else
      contentItems.push({
        type: "inputText",
        text: clipToolResultText(
          serializeToolResult(
            result,
            this.request.contextStrategy,
            entry.tool.name,
            call.arguments,
          ),
        ),
      });
    const payload =
      record?.kind === "agent_tool_result" && record.details && typeof record.details === "object"
        ? (record.details as Record<string, unknown>)
        : record;
    return {
      paused: false,
      response: {
        contentItems: contentItems.length
          ? contentItems
          : [{ type: "inputText", text: "Tool completed." }],
        success: !payload?.error && payload?.isError !== true,
      },
    };
  }
}
