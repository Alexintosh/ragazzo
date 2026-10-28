import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import { z } from "zod";
import type { NativeToolCall, NativeToolResponse } from "./native-tool-bridge.js";

const id = z.string().min(1).max(256);
export const codexBinding = {
  botId: id,
  threadId: id,
  runId: id,
  nativeKind: z.enum(["codex", "claude", "acp"]).optional(),
};
export const codexConfig = z.object({
  computerKey: id,
  historyGeneration: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().nonnegative().optional(),
  contextScope: id.optional(),
  /** Present only for a validated intro handover child execution. */
  applicationRunId: id.optional(),
  projectPath: z.string().min(1).max(4096),
  writeSubdirectory: z.string().min(1).max(4096).optional(),
  permission: z.enum(["workspace", "full"]),
});
export const CODEX_INLINE_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const encodedImageBudget = Math.ceil(CODEX_INLINE_IMAGE_MAX_BYTES / 3) * 4 + 1280;
const nativeTool = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().max(32768),
  inputSchema: z.record(z.string(), z.unknown()),
});
const nativeToolResponse = z.object({
  contentItems: z
    .array(
      z.union([
        z.object({ type: z.literal("inputText"), text: z.string().max(65536) }),
        z.object({ type: z.literal("inputImage"), imageUrl: z.string().max(encodedImageBudget) }),
      ]),
    )
    .max(128),
  success: z.boolean(),
});
const images = z
  .array(
    z
      .string()
      .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/)
      .max(encodedImageBudget),
  )
  .max(10)
  .refine(
    (values) => values.reduce((total, value) => total + value.length, 0) <= encodedImageBudget,
    "Native inline image budget exceeded",
  );
const nativeRunRequest = z.object({
  ...codexBinding,
  method: z.literal("codexRun"),
  config: codexConfig,
  prompt: z.string().max(1024 * 1024),
  images: images.optional(),
  imageFallback: z.string().max(8192).optional(),
  instructions: z.string().max(1024 * 1024),
  history: z
    .string()
    .max(1024 * 1024)
    .optional(),
  model: z.string().max(256),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  tools: z.array(nativeTool).max(512).optional(),
  toolCatalogFingerprint: z.string().max(256).optional(),
  session: id.optional(),
  after: z.number().int().nonnegative().default(0),
});
export const hostCodexRequests = [
  z.object({ ...codexBinding, method: z.literal("codexStatus") }),
  z.object({
    ...codexBinding,
    method: z.literal("codexModels"),
    projectPath: z.string().min(1).max(4096),
  }),
  nativeRunRequest,
  // Old hosts must reject explicit preferences instead of stripping effort.
  nativeRunRequest.extend({ method: z.literal("codexRunModelSettings") }),
  // Older hosts reject this method instead of stripping an unknown scope field.
  nativeRunRequest.extend({
    method: z.literal("codexRunScoped"),
  }),
  // An explicit method keeps old hosts from silently stripping transcript authorization.
  nativeRunRequest.extend({
    method: z.literal("codexRunContextScoped"),
    config: codexConfig.refine(
      (config) => Boolean(config.contextScope),
      "Native context scope is required",
    ),
  }),
  z.object({ ...codexBinding, method: z.literal("codexAbort") }),
  z.object({ ...codexBinding, method: z.literal("codexRetire"), computerKey: id }),
  z.object({
    ...codexBinding,
    method: z.literal("codexToolResult"),
    callId: id,
    response: nativeToolResponse,
  }),
  z.object({
    ...codexBinding,
    method: z.literal("codexSteer"),
    messageId: id,
    text: z.string().max(1024 * 1024),
    images: images.optional(),
    imageFallback: z.string().max(8192).optional(),
  }),
  z.object({
    ...codexBinding,
    method: z.literal("codexAnswer"),
    approvalId: id,
    answer: z.string().max(64 * 1024),
  }),
] as const;
export interface HostCodexStatus {
  available: boolean;
  authenticated: boolean;
  capabilities?: {
    workspace: boolean;
    images: boolean;
    applicationTools: boolean;
    steering: boolean;
    resume: boolean;
  };
  reason?: "cli-unavailable" | "login-required";
}
export type HostCodexSteeringResult =
  | { accepted: true }
  | { accepted: false; reason: "turn-ended" };
export interface HostCodexEvent {
  sequence: number;
  session?: string;
  event: AgentRuntimeEvent;
  approvalId?: string;
  outputFile?: { id: string; path: string; content: string };
  toolCall?: NativeToolCall;
}
export interface NativeCodexCheckpoint {
  thinkingLevel?: ThinkingLevel | null;
  runtime: "codex" | "claude" | "acp";
  version: 1;
  botId: string;
  threadId: string;
  runId: string;
  projectPath: string;
  writeSubdirectory?: string;
  computerKey: string;
  historyGeneration: number;
  runtimeGeneration?: number;
  contextScope?: string;
  permission: "workspace" | "full";
  session?: string;
  after: number;
  approvalId?: string;
  completed?: boolean;
  toolCatalogFingerprint?: string;
  pendingToolCall?: NativeToolCall & { response?: NativeToolResponse };
  /** Explicit parent binding for the one permitted catalog transition. */
  introHandover?: {
    applicationRunId: string;
    phase: "stopping" | "ready";
    answer: string;
  };
  effectOccurrences?: Array<{ executionId: string; fingerprint: string; occurrence: number }>;
}
