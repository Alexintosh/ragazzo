import { PURCHASE_CARD_FIELDS } from "@rakazo/contracts";
import { z } from "zod";

const id = z.string().min(1).max(256);
export const hostBrowserScope = z
  .object({
    spaceId: id,
    userId: id,
    botId: id.regex(/^[a-zA-Z0-9_-]+$/),
    mode: z.enum(["team", "dedicated"]),
    registrationId: id.nullable().optional(),
  })
  .strict();
export type HostBrowserIdentity = z.infer<typeof hostBrowserScope>;
export const hostBrowserInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("key"),
      key: z.string().min(1).max(128),
      modifiers: z.array(z.string().max(32)).max(8).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pointer"),
      x: z.number().finite().min(0).max(100_000),
      y: z.number().finite().min(0).max(100_000),
      button: z.enum(["left", "right"]).optional(),
      type: z.enum(["move", "down", "up", "click"]),
    })
    .strict(),
  z.object({ kind: z.literal("clipboard"), text: z.string().max(64 * 1024) }).strict(),
]);
const action = z.union([
  hostBrowserInput,
  z
    .object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      x: z.number().finite().min(0).max(100_000).optional(),
      y: z.number().finite().min(0).max(100_000).optional(),
      amount: z.number().finite().min(0).max(100_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal("open"), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.enum(["launch", "focus"]),
      application: z.string().min(1).max(256),
      uri: z.string().max(4096).optional(),
    })
    .strict(),
]);
const pageAction = z.union([
  z.object({ kind: z.literal("click"), ref: id }).strict(),
  z
    .object({
      kind: z.enum(["fill", "type"]),
      ref: id,
      text: z.string().max(64 * 1024),
      origin: z.string().max(4096).optional(),
      field: z.enum(["username", "password", "card"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("upload"),
      ref: id,
      paths: z.array(z.string().max(4096)).min(1).max(10),
      roots: z.array(z.string().max(4096)).max(32).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      text: z.string().max(64 * 1024),
      origin: z.string().max(4096),
      field: z.literal("card"),
      cardField: z.enum(PURCHASE_CARD_FIELDS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pay_token"),
      text: z.string().max(64 * 1024),
      origin: z.string().max(4096),
      merchantAccountId: id,
    })
    .strict(),
]);
export const hostBrowserPageCommand = z.discriminatedUnion("command", [
  z.object({ command: z.literal("navigate"), url: z.string().min(1).max(8192) }).strict(),
  z.object({ command: z.literal("snapshot") }).strict(),
  z.object({ command: z.literal("act"), actions: z.array(pageAction).min(1).max(24) }).strict(),
]);
export const hostBrowserPreviewCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("dialog"),
      dialogId: id,
      accept: z.boolean(),
      text: z
        .string()
        .max(64 * 1024)
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("state") }).strict(),
  z.object({ action: z.literal("navigate"), url: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.literal("newTab"), url: z.string().max(8192).optional() }).strict(),
  z.object({ action: z.enum(["selectTab", "closeTab"]), tabId: id }).strict(),
  z
    .object({
      action: z.literal("input"),
      inputs: z
        .array(
          z.union([
            hostBrowserInput,
            z
              .object({
                kind: z.literal("scroll"),
                direction: z.enum(["up", "down", "left", "right"]),
                x: z.number().finite().min(0).max(100_000).optional(),
                y: z.number().finite().min(0).max(100_000).optional(),
                amount: z.number().finite().min(0).max(100_000).optional(),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(32),
    })
    .strict(),
  z.object({ action: z.enum(["back", "forward", "reload"]) }).strict(),
]);
const base = {
  botId: id,
  runId: id.optional(),
  scope: hostBrowserScope,
  screenLeaseId: id.optional(),
};
export const hostBrowserRequests = [
  z.object({ ...base, method: z.literal("browserPage"), command: hostBrowserPageCommand }).strict(),
  z.object({ ...base, method: z.literal("browserObserve") }).strict(),
  z
    .object({
      ...base,
      method: z.literal("browserAct"),
      request: z
        .object({
          actions: z.array(action).min(1).max(24),
          observe: z.boolean().optional(),
          settleMs: z.number().int().min(0).max(10_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("browserScreen"),
      interactive: z.boolean(),
      controlToken: id.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("browserControl"),
      interactive: z.boolean(),
      controlToken: id.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("browserRelease"),
      keepWarm: z.boolean().optional(),
      cancel: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("browserRevokeScope"),
      botId: z.literal("setup"),
      runId: z.undefined().optional(),
      scope: z.object({ spaceId: id, userId: id, registrationId: id.optional() }).strict(),
    })
    .strict(),
] as const;
export type HostBrowserRequest = z.infer<(typeof hostBrowserRequests)[number]>;
