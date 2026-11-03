import { Trans, useLingui } from "@lingui/react/macro";
import { formatCreditAmount } from "@rakazo/core";
import { Button, Disclosure } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

export function HostedCredits({ fundingControls = false }: { fundingControls?: boolean }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const cache = useQueryClient();
  const status = useQuery(queries.hostedCredits.status.queryOptions());
  const tariffs = useQuery(queries.hostedCredits.tariffs.queryOptions());
  const billing = useQuery({ ...queries.billing.status.queryOptions(), enabled: fundingControls });
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function selectFunding(funding: "byok" | "credits") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding });
      await Promise.all([
        cache.invalidateQueries({ queryKey: queries.me.key() }),
        cache.invalidateQueries({ queryKey: queries.bootstrap.key() }),
        cache.invalidateQueries({ queryKey: queries.models.key() }),
        cache.invalidateQueries({ queryKey: queries.billing.key() }),
        cache.invalidateQueries({ queryKey: queries.hostedCredits.key() }),
      ]);
    } catch (error) {
      setError(errorText(error, t`Could not update billing`));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (status.isPending)
    return (
      <p role="status">
        <Trans>Loading…</Trans>
      </p>
    );
  if (status.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        <Trans>Could not load credits</Trans>
      </p>
    );
  const credits = (micros: string) => formatCreditAmount(micros, i18n.locale);
  const daily = credits(status.data.dailyAllowanceMicros);
  const next = status.data.nextGrantAt
    ? new Date(status.data.nextGrantAt).toLocaleString(i18n.locale)
    : null;
  return (
    <section data-testid="hosted-credits" className="space-y-4 rounded-xl border p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm text-muted-foreground">
          <Trans>Available credits</Trans>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          <Trans>Refresh</Trans>
        </Button>
      </div>
      <p className="text-3xl font-medium tabular-nums">{credits(status.data.balanceMicros)}</p>
      {!status.data.available ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Hosted models are paused</Trans>
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <Trans>{daily} credits daily</Trans>
        {next ? (
          <>
            {" "}
            · <Trans>Renews {next}</Trans>
          </>
        ) : null}
      </p>
      {fundingControls && billing.data?.canManage ? (
        <div className="flex flex-wrap gap-3">
          {billing.data.funding === "byok" ? (
            <Button
              disabled={pending || !status.data.available}
              onClick={() => void selectFunding("credits")}
            >
              <Trans>Use Rakazo credits</Trans>
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void selectFunding("byok")}
            >
              <Trans>Use my subscription or API key</Trans>
            </Button>
          )}
        </div>
      ) : null}
      {error || billing.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? t`Could not load billing`}
        </p>
      ) : null}
      <Disclosure summary={<Trans>Model rates</Trans>}>
        <p className="mb-3 text-sm text-muted-foreground">
          <Trans>1 credit = $0.001. Model multipliers apply to provider cost.</Trans>
        </p>
        {tariffs.isError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load model rates</Trans>
          </p>
        ) : null}
        <ul className="space-y-2 text-sm">
          {tariffs.data?.map((tariff) => (
            <li key={`${tariff.provider}/${tariff.model}`} className="flex justify-between gap-3">
              <span className="break-all">
                {tariff.provider} / {tariff.model}
              </span>
              <span>{tariff.multiplierBps / 10_000}×</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
