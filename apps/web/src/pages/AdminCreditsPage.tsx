import { Trans, useLingui } from "@lingui/react/macro";
import type { RpcOutput } from "@rakazo/contracts";
import { creditAmountInput, formatCreditAmount, parseCreditAmount } from "@rakazo/core";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cloneElement, useId, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

type Account = RpcOutput<"creditAdmin/accounts">["accounts"][number];
type Policy = RpcOutput<"creditAdmin/policy">;
type Tariff = RpcOutput<"creditAdmin/tariffs">[number];
const creditKey = ["credit-admin"];

/** A failed response can follow a committed write. Reuse its key for the same payload. */
function useAuditedAction() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const busy = useRef(false);
  async function run(payload: object, write: (key: string) => Promise<unknown>) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    const serialized = JSON.stringify(payload);
    if (attempt.current?.payload !== serialized)
      attempt.current = { payload: serialized, key: crypto.randomUUID() };
    try {
      await write(attempt.current.key);
      attempt.current = null;
      void cache.invalidateQueries({ queryKey: creditKey });
      return true;
    } catch (error) {
      setError(errorText(error, t`Could not update credits`));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { pending, error, run };
}

function Field({ label, children }: { label: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid gap-2 text-sm font-medium">
      {label}
      {cloneElement(children, { id })}
    </label>
  );
}
function Failure({ error }: { error: unknown }) {
  const { t } = useLingui();
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {errorText(error, t`Could not load credits`)}
    </p>
  ) : null;
}

export function AdminCreditsPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (me.isError) return <Failure error={me.error} />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Credit administration</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <AdminCreditsPanel />
      </main>
    </div>
  );
}

export function AdminCreditsPanel() {
  const { t, i18n } = useLingui();
  const overview = useQuery({
    queryKey: [...creditKey, "overview"],
    queryFn: () => rpc.creditAdmin.overview(),
  });
  const policy = useQuery({
    queryKey: [...creditKey, "policy"],
    queryFn: () => rpc.creditAdmin.policy(),
  });
  const tariffs = useQuery({
    queryKey: [...creditKey, "tariffs"],
    queryFn: () => rpc.creditAdmin.tariffs(),
  });
  const [selected, setSelected] = useState<Account | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const accounts = useQuery({
    queryKey: [...creditKey, "accounts", search, cursor],
    queryFn: () => rpc.creditAdmin.accounts({ query: search || undefined, cursor, limit: 25 }),
  });
  const credits = (micros: string) => formatCreditAmount(micros, i18n.locale);
  return (
    <div data-testid="admin-credits" className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <Failure error={overview.error || policy.error || tariffs.error} />
      {overview.data ? (
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">
              <Trans>Accounts</Trans>
            </dt>
            <dd className="mt-1 text-2xl tabular-nums">{overview.data.accountCount}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">
              <Trans>Available credits</Trans>
            </dt>
            <dd className="mt-1 text-2xl tabular-nums">{credits(overview.data.balanceMicros)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">
              <Trans>Pending credits</Trans>
            </dt>
            <dd className="mt-1 text-2xl tabular-nums">
              {credits(overview.data.pendingMicros)}{" "}
              <span className="text-sm text-muted-foreground">({overview.data.pendingCount})</span>
            </dd>
          </div>
        </dl>
      ) : null}
      {policy.data ? <PolicyEditor key={JSON.stringify(policy.data)} policy={policy.data} /> : null}
      {tariffs.data ? <TariffEditor tariffs={tariffs.data} /> : null}
      <section className="space-y-4 border-t pt-6" aria-labelledby="credit-accounts-title">
        <h2 id="credit-accounts-title" className="font-medium">
          <Trans>Accounts</Trans>
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setCursor(undefined);
            setSearch(query.trim());
          }}
        >
          <Input
            aria-label={t`Search accounts`}
            value={query}
            maxLength={128}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            <Trans>Search</Trans>
          </Button>
        </form>
        <Failure error={accounts.error} />
        {accounts.isPending ? (
          <p role="status">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        <ul className="divide-y rounded-xl border">
          {accounts.data?.accounts.map((account) => (
            <li
              key={account.organizationId}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{account.name}</p>
                <p className="text-sm text-muted-foreground">
                  {credits(account.balanceMicros)} <Trans>credits</Trans>
                </p>
              </div>
              <Button variant="outline" onClick={() => setSelected(account)}>
                <Trans>Manage</Trans>
              </Button>
            </li>
          ))}
        </ul>
        {accounts.data?.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No accounts</Trans>
          </p>
        ) : null}
        <div className="flex gap-2">
          {cursor ? (
            <Button variant="ghost" onClick={() => setCursor(undefined)}>
              <Trans>First page</Trans>
            </Button>
          ) : null}
          {accounts.data?.nextCursor ? (
            <Button variant="secondary" onClick={() => setCursor(accounts.data!.nextCursor!)}>
              <Trans>Next page</Trans>
            </Button>
          ) : null}
        </div>
      </section>
      <CostReport />
      <Journal />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          {selected ? <AccountEditor key={selected.organizationId} account={selected} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PolicyEditor({ policy }: { policy: Policy }) {
  const switchId = useId();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [daily, setDaily] = useState(creditAmountInput(policy.defaultDailyAllowanceMicros));
  const [budget, setBudget] = useState(creditAmountInput(policy.dailyGrantBudgetMicros));
  const [reason, setReason] = useState("");
  const action = useAuditedAction();
  const dailyMicros = parseCreditAmount(daily);
  const budgetMicros = parseCreditAmount(budget);
  const valid =
    dailyMicros !== null &&
    budgetMicros !== null &&
    BigInt(dailyMicros) >= 0n &&
    BigInt(budgetMicros) >= 0n;
  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="credit-policy-title">
      <h2 id="credit-policy-title" className="font-medium">
        <Trans>Hosted credit policy</Trans>
      </h2>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !reason.trim()) return;
          const input = {
            enabled,
            defaultDailyAllowanceMicros: dailyMicros!,
            dailyGrantBudgetMicros: budgetMicros!,
            reason: reason.trim(),
          };
          void action.run(input, (idempotencyKey) =>
            rpc.creditAdmin.updatePolicy({ ...input, idempotencyKey }),
          );
        }}
      >
        <label htmlFor={switchId} className="flex items-center gap-3 text-sm">
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={action.pending}
          />
          <Trans>Enable hosted models</Trans>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={<Trans>Daily credits per account</Trans>}>
            <Input
              inputMode="decimal"
              value={daily}
              onChange={(event) => setDaily(event.target.value)}
              disabled={action.pending}
            />
          </Field>
          <Field label={<Trans>Daily grant budget</Trans>}>
            <Input
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              disabled={action.pending}
            />
          </Field>
        </div>
        <p className="text-sm text-muted-foreground">
          <Trans>Daily grants use UTC. A zero budget disables grants.</Trans>
        </p>
        <Field label={<Trans>Reason</Trans>}>
          <Input
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            disabled={action.pending}
          />
        </Field>
        <Failure error={action.error} />
        <Button type="submit" disabled={action.pending || !valid || !reason.trim()}>
          <Trans>Save policy</Trans>
        </Button>
      </form>
    </section>
  );
}

function TariffEditor({ tariffs }: { tariffs: Tariff[] }) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [multiplier, setMultiplier] = useState("1");
  const [reason, setReason] = useState("");
  const action = useAuditedAction();
  const bps = Math.round(Number(multiplier) * 10_000);
  const valid =
    provider.trim() &&
    model.trim() &&
    /^\d+(?:\.\d{1,4})?$/.test(multiplier) &&
    bps > 0 &&
    bps <= 1_000_000;
  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="credit-tariffs-title">
      <h2 id="credit-tariffs-title" className="font-medium">
        <Trans>Provider and model tariffs</Trans>
      </h2>
      <p className="text-sm text-muted-foreground">
        <Trans>1× charges provider cost. Changes apply to new reservations.</Trans>
      </p>
      <ul className="divide-y">
        {tariffs.map((tariff) => (
          <li
            key={`${tariff.provider}/${tariff.model}`}
            className="flex items-center justify-between gap-3 py-2 text-sm"
          >
            <span className="break-all">
              {tariff.provider} / {tariff.model} · {tariff.multiplierBps / 10_000}×
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={action.pending}
              onClick={() => {
                setProvider(tariff.provider);
                setModel(tariff.model);
                setMultiplier(String(tariff.multiplierBps / 10_000));
              }}
            >
              <Trans>Edit</Trans>
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !reason.trim()) return;
          const input = {
            provider: provider.trim(),
            model: model.trim(),
            multiplierBps: bps,
            reason: reason.trim(),
          };
          void action.run(input, (idempotencyKey) =>
            rpc.creditAdmin.updateTariff({ ...input, idempotencyKey }),
          );
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={<Trans>Provider</Trans>}>
            <Input
              value={provider}
              maxLength={128}
              onChange={(event) => setProvider(event.target.value)}
              disabled={action.pending}
            />
          </Field>
          <Field label={<Trans>Model</Trans>}>
            <Input
              value={model}
              maxLength={256}
              onChange={(event) => setModel(event.target.value)}
              disabled={action.pending}
            />
          </Field>
          <Field label={<Trans>Cost multiplier</Trans>}>
            <Input
              inputMode="decimal"
              value={multiplier}
              onChange={(event) => setMultiplier(event.target.value)}
              disabled={action.pending}
            />
          </Field>
        </div>
        <Field label={<Trans>Reason</Trans>}>
          <Input
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            disabled={action.pending}
          />
        </Field>
        <Failure error={action.error} />
        <Button type="submit" disabled={action.pending || !valid || !reason.trim()}>
          <Trans>Save tariff</Trans>
        </Button>
      </form>
    </section>
  );
}

function AccountEditor({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [allowance, setAllowance] = useState(
    account.dailyAllowanceMicros === null ? "" : creditAmountInput(account.dailyAllowanceMicros),
  );
  const [allowanceReason, setAllowanceReason] = useState("");
  const adjustment = useAuditedAction();
  const daily = useAuditedAction();
  const balance = useQuery({
    queryKey: [...creditKey, "account", account.organizationId],
    queryFn: () => rpc.creditAdmin.accounts({ query: account.organizationId, limit: 1 }),
  });
  const current =
    balance.data?.accounts.find((row) => row.organizationId === account.organizationId) ?? account;
  const micros = parseCreditAmount(amount);
  const allowanceMicros = allowance.trim() ? parseCreditAmount(allowance) : null;
  const validAllowance =
    !allowance.trim() || (allowanceMicros !== null && BigInt(allowanceMicros) >= 0n);
  async function adjust() {
    if (!micros || micros === "0" || !reason.trim()) return;
    const input = {
      organizationId: account.organizationId,
      amountMicros: micros,
      reason: reason.trim(),
    };
    if (
      await adjustment.run(input, (idempotencyKey) =>
        rpc.creditAdmin.adjustment({ ...input, idempotencyKey }),
      )
    ) {
      setAmount("");
      setReason("");
      setConfirm(false);
      setSaved(true);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{account.name}</DialogTitle>
        <DialogDescription>
          <Trans>Available credits</Trans>: {formatCreditAmount(current.balanceMicros, i18n.locale)}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (micros && BigInt(micros) < 0n) setConfirm(true);
          else void adjust();
        }}
      >
        <Field label={<Trans>Credit adjustment</Trans>}>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirm(false);
              setSaved(false);
            }}
            disabled={adjustment.pending}
            placeholder={t`Positive to grant, negative to revoke`}
          />
        </Field>
        <Field label={<Trans>Reason</Trans>}>
          <Textarea
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
              setConfirm(false);
            }}
            disabled={adjustment.pending}
          />
        </Field>
        <Failure error={adjustment.error} />
        {saved ? (
          <p role="status" className="text-sm">
            <Trans>Adjustment recorded</Trans>
          </p>
        ) : null}
        {confirm && micros ? (
          <div className="space-y-3 rounded-lg border border-destructive p-3">
            <p role="alert" className="text-sm">
              <Trans>
                Revoke {formatCreditAmount((-BigInt(micros)).toString(), i18n.locale)} credits from{" "}
                {account.name}?
              </Trans>
            </p>
            <Button
              variant="destructive"
              disabled={adjustment.pending}
              onClick={() => void adjust()}
            >
              <Trans>Confirm revocation</Trans>
            </Button>
          </div>
        ) : (
          <Button
            type="submit"
            disabled={
              adjustment.pending || daily.pending || !micros || micros === "0" || !reason.trim()
            }
          >
            {micros && BigInt(micros) < 0n ? (
              <Trans>Review revocation</Trans>
            ) : (
              <Trans>Grant credits</Trans>
            )}
          </Button>
        )}
      </form>
      <form
        className="space-y-4 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validAllowance || !allowanceReason.trim()) return;
          const input = {
            organizationId: account.organizationId,
            dailyAllowanceMicros: allowanceMicros,
            reason: allowanceReason.trim(),
          };
          void daily
            .run(input, (idempotencyKey) =>
              rpc.creditAdmin.updateAllowance({ ...input, idempotencyKey }),
            )
            .then((ok) => {
              if (ok) setAllowanceReason("");
            });
        }}
      >
        <Field label={<Trans>Daily allowance override</Trans>}>
          <Input
            inputMode="decimal"
            value={allowance}
            placeholder={t`Deployment default`}
            onChange={(event) => setAllowance(event.target.value)}
            disabled={daily.pending}
          />
        </Field>
        <Field label={<Trans>Reason</Trans>}>
          <Input
            value={allowanceReason}
            maxLength={500}
            onChange={(event) => setAllowanceReason(event.target.value)}
            disabled={daily.pending}
          />
        </Field>
        <Failure error={daily.error} />
        <Button
          type="submit"
          variant="secondary"
          disabled={
            daily.pending || adjustment.pending || !validAllowance || !allowanceReason.trim()
          }
        >
          <Trans>Save allowance</Trans>
        </Button>
      </form>
      <CostReport organizationId={account.organizationId} />
      <Journal organizationId={account.organizationId} />
    </>
  );
}

function Journal({ organizationId }: { organizationId?: string }) {
  const { t, i18n } = useLingui();
  const [cursor, setCursor] = useState<string>();
  const journal = useQuery({
    queryKey: [...creditKey, "journal", organizationId, cursor],
    queryFn: () => rpc.creditAdmin.journal({ organizationId, cursor, limit: 25 }),
  });
  return (
    <section className="space-y-4 border-t pt-6" aria-label={t`Credit history`}>
      <h2 className="font-medium">
        <Trans>Credit history</Trans>
      </h2>
      <Failure error={journal.error} />
      {journal.data?.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No events</Trans>
        </p>
      ) : null}
      <ul className="divide-y">
        {journal.data?.events.map((event) => (
          <li key={event.id} className="space-y-1 py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                {event.kind} · {formatCreditAmount(event.amountMicros, i18n.locale)}{" "}
                <Trans>credits</Trans>
              </span>
              <time dateTime={event.createdAt} className="text-muted-foreground">
                {new Date(event.createdAt).toLocaleString(i18n.locale)}
              </time>
            </div>
            {event.reason ? <p className="break-words">{event.reason}</p> : null}
            <p className="break-all text-xs text-muted-foreground">
              {[event.organizationId, event.actorId, event.provider, event.model]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        {cursor ? (
          <Button variant="ghost" onClick={() => setCursor(undefined)}>
            <Trans>First page</Trans>
          </Button>
        ) : null}
        {journal.data?.nextCursor ? (
          <Button variant="secondary" onClick={() => setCursor(journal.data!.nextCursor!)}>
            <Trans>Next events</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CostReport({ organizationId }: { organizationId?: string }) {
  const { t, i18n } = useLingui();
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [range, setRange] = useState({ from, to });
  const duration = Date.parse(to) - Date.parse(from);
  const valid = duration > 0 && duration <= 93 * 86_400_000;
  const report = useQuery({
    queryKey: [...creditKey, "report", organizationId, range],
    queryFn: () => rpc.creditAdmin.costReport({ ...range, organizationId }),
  });
  const money = (usd: number) =>
    new Intl.NumberFormat(i18n.locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(usd);
  return (
    <section className="space-y-4 border-t pt-6" aria-label={t`Provider costs and credits`}>
      <h2 className="font-medium">
        <Trans>Provider costs and credits</Trans>
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) setRange({ from, to });
        }}
      >
        <Field label={<Trans>From (UTC)</Trans>}>
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          />
        </Field>
        <Field label={<Trans>Until (UTC, exclusive)</Trans>}>
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
        </Field>
        <Button type="submit" variant="secondary" disabled={!valid || report.isFetching}>
          <Trans>Apply dates</Trans>
        </Button>
      </form>
      {!valid ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Choose a date range between 1 and 93 days.</Trans>
        </p>
      ) : null}
      <Failure error={report.error} />
      {report.isPending ? (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {report.data?.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No usage in this period</Trans>
        </p>
      ) : null}
      {report.data?.rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              <Trans>Provider costs and credits</Trans>
            </caption>
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4">
                  <Trans>Provider / model</Trans>
                </th>
                <th scope="col" className="py-2 pr-4">
                  <Trans>Known provider cost</Trans>
                </th>
                <th scope="col" className="py-2 pr-4">
                  <Trans>Charged credits</Trans>
                </th>
                <th scope="col" className="py-2 pr-4">
                  <Trans>Pending credits</Trans>
                </th>
                <th scope="col" className="py-2">
                  <Trans>Unknown cost</Trans>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.data.rows.map((row) => (
                <tr key={`${row.provider}/${row.model}`}>
                  <th scope="row" className="py-3 pr-4 font-normal">
                    {row.provider}
                    <br />
                    <span className="text-muted-foreground">{row.model}</span>
                  </th>
                  <td className="pr-4 tabular-nums">
                    {money(row.providerCostUsd)}{" "}
                    <span className="text-muted-foreground">({row.knownCostCount})</span>
                  </td>
                  <td className="pr-4 tabular-nums">
                    {formatCreditAmount(row.chargedMicros, i18n.locale)}
                  </td>
                  <td className="pr-4 tabular-nums">
                    {formatCreditAmount(row.pendingMicros, i18n.locale)} ({row.pendingCount})
                  </td>
                  <td className="tabular-nums">{row.unknownCostCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
