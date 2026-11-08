import type { FarmingControlPositionDetail } from "@rakazo/contracts";
import { FarmingControlDecimalSchema } from "@rakazo/contracts";
import * as z from "zod";

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4_000);
const id = z.string().min(1).max(500);
const accountFields = z.object({
  accountAddress: text.optional(),
  account: text.optional(),
  walletAddress: text.optional(),
  owner: text.optional(),
});
export const detailTransactionSource = z.object({
  namespace: text.optional(),
  chainId: z
    .union([z.string().max(100), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
    .optional(),
  hash: text.optional(),
});
export const detailEntrySource = z.object({
  activityId: id,
  activityKind: text,
  status: text,
  sourceId: text,
  occurredAtMs: ms.nullable(),
  namespace: text.optional(),
  chainId: z.string().max(100).nullable(),
  hash: text,
});
export const detailActivitiesSource = z.object({
  items: z
    .array(
      z.object({
        id,
        positionId: id,
        kind: text,
        status: text,
        sourceId: text,
        evidenceId: id.nullable(),
        occurredAtMs: ms.nullable(),
        recordedAtMs: ms,
        transactionRef: detailTransactionSource.nullable(),
        properties: accountFields.extend({ observed: accountFields.optional() }),
        legs: z
          .array(
            z.object({
              amountKind: z.enum(["raw", "decimal"]),
              amountText: text,
              assetSnapshot: accountFields.extend({ symbol: text.optional() }),
              properties: accountFields,
            }),
          )
          .max(500),
      }),
    )
    .max(101),
});
export const detailInventorySource = z.object({
  asOfMs: ms,
  walletVisibility: z.object({ revision: ms }),
  walletVisibilityCoverage: z.object({ complete: z.boolean() }).optional(),
  items: z
    .array(
      z.object({
        id,
        positionId: id,
        account: text.nullable(),
        observedAtMs: ms,
        sourceObservationId: id,
        retrievalComplete: z.boolean().nullable(),
        reward: z.object({
          token: text.nullable(),
          symbol: text.nullable(),
          amountRaw: z.string().regex(/^\d+$/).max(12_000),
          amount: FarmingControlDecimalSchema.max(12_000).nullable(),
        }),
        informational: z
          .object({
            quality: z.enum(["current", "fallback", "unknown", "invalidated"]),
            quantityObservedAtMs: ms.nullable(),
            readiness: text,
          })
          .optional(),
        execution: z.object({ claimSupported: z.boolean(), reason: text.nullable() }),
      }),
    )
    .max(10_000),
});
export type PositionDetailPath =
  | `/positions/${string}/activities?${string}`
  | `/harvest/inventory?${string}`;
type Detail = Extract<FarmingControlPositionDetail, { status: "matched" }>;
type Activity = Detail["activities"]["items"][number];
const explorers: Readonly<Record<string, string>> = {
  "1": "etherscan.io",
  "10": "optimistic.etherscan.io",
  "137": "polygonscan.com",
  "8453": "basescan.org",
  "42161": "arbiscan.io",
};
export function detailTransaction(
  ref: z.infer<typeof detailTransactionSource> | null,
): Activity["transaction"] {
  if (
    !ref ||
    (ref.namespace !== undefined && ref.namespace !== "eip155") ||
    !/^0x[0-9a-fA-F]{64}$/.test(ref.hash ?? "")
  )
    return null;
  const chainId = ref.chainId === undefined ? null : String(ref.chainId);
  const host = chainId === null ? undefined : explorers[chainId];
  const hash = ref.hash!.toLowerCase();
  return { chainId, hash, explorerUrl: host ? `https://${host}/tx/${hash}` : null };
}
/** The FC activities endpoint is canonical/unscoped. With a hidden wallet, only
 * independently attributed rows are safe; current holdings never prove history. */
export function detailActivity(
  row: z.infer<typeof detailActivitiesSource>["items"][number],
  hidden: boolean,
  visibleAccounts: ReadonlySet<string>,
): Activity | null {
  if (hidden) {
    const records = [
      row.properties,
      row.properties.observed,
      ...row.legs.flatMap((leg) => [leg.properties, leg.assetSnapshot]),
    ];
    const accounts = records.flatMap((record) =>
      Object.values(record ?? {}).filter(
        (value): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
      ),
    );
    if (
      !accounts.length ||
      !accounts.every((account) => visibleAccounts.has(account.toLowerCase()))
    )
      return null;
  }
  const leg = row.legs.length === 1 ? row.legs[0] : undefined;
  const amount =
    leg?.amountKind === "decimal" ? FarmingControlDecimalSchema.safeParse(leg.amountText) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    occurredAtMs: row.occurredAtMs,
    recordedAtMs: row.recordedAtMs,
    sourceId: row.sourceId,
    evidenceId: row.evidenceId,
    transaction: detailTransaction(row.transactionRef),
    amount: amount?.success ? amount.data : null,
    token: leg?.assetSnapshot.symbol ?? null,
  };
}
