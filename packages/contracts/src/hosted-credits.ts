import * as z from "zod";

/** Integer USD micros on the wire; 1,000 micros is one displayed credit. */
export const CREDIT_MICROS_PER_CREDIT = 1_000;
export const MAX_CREDIT_MICROS = 9_000_000_000_000_000n;
export const CreditMicrosSchema = z.string().regex(/^-?(0|[1-9]\d{0,17})$/);
const positiveMicros = CreditMicrosSchema.pipe(z.string().refine((value) => BigInt(value) >= 0n));
const mutationMicros = CreditMicrosSchema.pipe(
  z.string().refine(
    (value) => {
      const amount = BigInt(value);
      return amount >= -MAX_CREDIT_MICROS && amount <= MAX_CREDIT_MICROS;
    },
    { message: "Credit amount exceeds the supported limit" },
  ),
);
const allowanceMicros = mutationMicros.pipe(z.string().refine((value) => BigInt(value) >= 0n));
const auditInput = {
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
};
export const HostedCreditPolicySchema = z.object({
  enabled: z.boolean(),
  defaultDailyAllowanceMicros: positiveMicros,
  /** Zero disables free grants. Shared across all organizations per UTC day. */
  dailyGrantBudgetMicros: positiveMicros,
});
export const UpdateHostedCreditPolicyInputSchema = HostedCreditPolicySchema.extend({
  ...auditInput,
  defaultDailyAllowanceMicros: allowanceMicros,
  dailyGrantBudgetMicros: allowanceMicros,
});
export const HostedCreditTariffSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  /** 10,000 charges the known provider cost, without markup. */
  multiplierBps: z.number().int().min(1).max(1_000_000),
});
export const UpdateHostedCreditTariffInputSchema = HostedCreditTariffSchema.extend(auditInput);
export const HostedCreditStatusSchema = z.object({
  /** The deployment currently accepts hosted calls, regardless of the account's funding choice. */
  available: z.boolean().default(false),
  enabled: z.boolean(),
  balanceMicros: CreditMicrosSchema,
  dailyAllowanceMicros: positiveMicros,
  dailyGrantedMicros: positiveMicros,
  nextGrantAt: z.string().nullable(),
});
export const CreditAdminOverviewSchema = z.object({
  accountCount: z.number().int().nonnegative(),
  balanceMicros: CreditMicrosSchema,
  pendingCount: z.number().int().nonnegative(),
  pendingMicros: CreditMicrosSchema,
});
export const CreditAccountSchema = z.object({
  organizationId: z.string(),
  name: z.string(),
  mode: z.string().nullable(),
  balanceMicros: CreditMicrosSchema,
  dailyAllowanceMicros: positiveMicros.nullable(),
});
export const CreditAccountsInputSchema = z.object({
  query: z.string().trim().max(128).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const CreditAccountsPageSchema = z.object({
  accounts: z.array(CreditAccountSchema),
  nextCursor: z.string().nullable(),
});
export const CreditJournalInputSchema = z.object({
  organizationId: z.string().max(128).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const CreditJournalEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  organizationId: z.string().nullable(),
  amountMicros: CreditMicrosSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  actorId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export const CreditJournalPageSchema = z.object({
  events: z.array(CreditJournalEventSchema),
  nextCursor: z.string().nullable(),
});
export const CreditAdjustmentInputSchema = z.object({
  organizationId: z.string().min(1).max(128),
  amountMicros: mutationMicros.pipe(z.string().refine((value) => BigInt(value) !== 0n)),
  ...auditInput,
});
export const CreditAllowanceInputSchema = z.object({
  organizationId: z.string().min(1).max(128),
  dailyAllowanceMicros: allowanceMicros.nullable(),
  ...auditInput,
});
const utcDay = z.iso.date();
export const CreditCostReportInputSchema = z
  .object({
    /** Inclusive UTC day. */
    from: utcDay,
    /** Exclusive UTC day; at most 93 days after `from`. */
    to: utcDay,
    organizationId: z.string().max(128).optional(),
  })
  .refine(
    ({ from, to }) => {
      const duration = Date.parse(to) - Date.parse(from);
      return duration > 0 && duration <= 93 * 86_400_000;
    },
    { message: "Choose a UTC date range between 1 and 93 days" },
  );
export const CreditCostReportRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** Known recorded provider cost, independent of credits charged. */
  providerCostUsd: z.number().nonnegative(),
  chargedMicros: CreditMicrosSchema,
  pendingMicros: CreditMicrosSchema,
  knownCostCount: z.number().int().nonnegative(),
  unknownCostCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
});
export const CreditCostReportSchema = z.object({
  from: utcDay,
  to: utcDay,
  rows: z.array(CreditCostReportRowSchema),
});
export type HostedCreditStatus = z.infer<typeof HostedCreditStatusSchema>;
export type CreditCostReportInput = z.infer<typeof CreditCostReportInputSchema>;
export type CreditCostReportRow = z.infer<typeof CreditCostReportRowSchema>;
