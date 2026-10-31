import { Trans, useLingui } from "@lingui/react/macro";
import { MAX_MODEL_TIMEOUT_MS, parseModelTimeoutMs } from "@rakazo/contracts";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useId } from "react";

export function RequestTimeoutFields({
  streamTimeoutMs,
  streamIdleTimeoutMs,
  disabled,
  onChange,
}: {
  streamTimeoutMs: string;
  streamIdleTimeoutMs: string;
  disabled: boolean;
  onChange: (headers: string, idle: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  return (
    <Disclosure
      className="mt-4 text-[13.5px] text-muted-foreground"
      summary={<Trans>Request timeouts</Trans>}
    >
      <div className="mt-3 grid gap-3">
        {[
          {
            id: `${id}-headers`,
            label: t`Time to response headers (ms)`,
            value: streamTimeoutMs,
            change: (value: string) => onChange(value, streamIdleTimeoutMs),
          },
          {
            id: `${id}-idle`,
            label: t`Stream inactivity (ms)`,
            value: streamIdleTimeoutMs,
            change: (value: string) => onChange(streamTimeoutMs, value),
          },
        ].map(({ id, label, value, change }) => (
          <label key={id} htmlFor={id} className="block">
            {label}
            <Input
              id={id}
              type="number"
              min={1}
              max={MAX_MODEL_TIMEOUT_MS}
              step={1}
              aria-label={label}
              aria-invalid={value.trim() !== "" && parseModelTimeoutMs(value) === undefined}
              value={value}
              disabled={disabled}
              placeholder={t`Server default`}
              onChange={(event) => change(event.target.value)}
              className="mt-2 h-10 text-foreground"
            />
          </label>
        ))}
        <p>
          <Trans>Leave blank to use server defaults.</Trans>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange("900000", "900000")}
        >
          <Trans>Slow local inference (15 min)</Trans>
        </Button>
      </div>
    </Disclosure>
  );
}
