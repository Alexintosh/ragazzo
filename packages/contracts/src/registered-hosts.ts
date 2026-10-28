import * as z from "zod";
import { Id } from "./ids.js";

export const RegisteredHostSchema = z.object({
  id: Id,
  name: z.string(),
  endpoint: z.string(),
  revokedAt: z.string().nullable(),
  revocationPending: z.boolean().optional(),
  healthStatus: z.enum(["unchecked", "available", "unavailable", "revoked"]),
  healthCheckedAt: z.string().nullable(),
});
export type RegisteredHost = z.infer<typeof RegisteredHostSchema>;
export const RegisterHostInput = z.object({
  name: z.string().trim().min(1).max(80),
  endpoint: z.string().trim().url().max(2048),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  trusted: z.literal(true),
});

/** Browse only the selected execution host; credentials and endpoints remain server-owned. */
export const HostDirectoriesInput = z
  .object({
    hostId: Id.nullable(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"))
      .optional(),
  })
  .strict();
export const HostDirectoriesViewSchema = z.object({
  path: z.string().min(1).max(4096),
  parent: z.string().min(1).max(4096).nullable(),
  directories: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
      }),
    )
    .max(500),
  truncated: z.boolean(),
});
export type HostDirectoriesInput = z.infer<typeof HostDirectoriesInput>;
export type HostDirectoriesView = z.infer<typeof HostDirectoriesViewSchema>;
