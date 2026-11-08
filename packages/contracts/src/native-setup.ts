import { z } from "zod";

export const NativeSetupKind = z.enum(["codex", "claude", "acp"]);
export const NativeSetupAction = z.enum(["status", "install", "login", "session", "cancel"]);
/** Intents only. Commands, environment, paths and consent are never supplied by clients. */
export const NativeSetupInput = z
  .object({
    hostId: z.string().min(1).max(256).nullable(),
    kind: NativeSetupKind,
    action: NativeSetupAction,
    sessionId: z.uuid().optional(),
  })
  .strict();
export const NativeSetupViewSchema = z.object({
  kind: NativeSetupKind,
  available: z.boolean(),
  authenticated: z.boolean(),
  managed: z.boolean(),
  installSupported: z.boolean(),
  loginSupported: z.boolean(),
  session: z
    .object({
      id: z.uuid(),
      action: z.enum(["install", "login"]),
      state: z.enum(["awaiting-consent", "running", "succeeded", "failed", "cancelled", "expired"]),
      expiresAt: z.string(),
      command: z.array(z.string()),
      destination: z.string(),
      localApproval: z.string(),
      verificationUrl: z
        .string()
        .url()
        .regex(/^https:\/\//)
        .optional(),
      userCode: z.string().max(64).optional(),
    })
    .optional(),
});
export type NativeSetupInput = z.infer<typeof NativeSetupInput>;
export type NativeSetupView = z.infer<typeof NativeSetupViewSchema>;
export type NativeSetupKind = z.infer<typeof NativeSetupKind>;
