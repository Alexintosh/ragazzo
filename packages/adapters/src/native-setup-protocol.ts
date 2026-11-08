import { NativeSetupAction, NativeSetupKind } from "@rakazo/contracts";
import { z } from "zod";

export const nativeSetupRequests = [
  z
    .object({
      method: z.literal("nativeSetup"),
      botId: z.literal("setup"),
      runId: z.undefined().optional(),
      scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
      registrationId: z.string().min(1).max(256).nullable(),
      kind: NativeSetupKind,
      action: NativeSetupAction,
      sessionId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("nativeSetupScopeRevoke"),
      botId: z.literal("setup"),
      runId: z.undefined().optional(),
      scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      method: z.literal("nativeSetupRevoke"),
      botId: z.literal("setup"),
      runId: z.undefined().optional(),
      registrationId: z.string().min(1).max(256),
    })
    .strict(),
] as const;
export type NativeSetupHostRequest = z.infer<(typeof nativeSetupRequests)[0]>;
