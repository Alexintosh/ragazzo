import { Trans, useLingui } from "@lingui/react/macro";
import type { RegisteredHost } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";

export function RegisteredHostPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const id = useId();
  const generation = useRef(0);
  const intent = useRef(0);
  const [hosts, setHosts] = useState<RegisteredHost[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    generation.current++;
    setHosts([]);
    setBusy(false);
    setToken("");
    setOpen(false);
    void rpc.hosts
      .list()
      .then((rows) => {
        if (active) setHosts(rows);
      })
      .catch(() => {
        if (active) setError(t`Could not load hosts`);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [rpc, t]);
  const selected = hosts.find((host) => host.id === value);
  async function run(action: (current: () => boolean) => Promise<void>) {
    const started = generation.current;
    const input = intent.current;
    const current = () => generation.current === started && intent.current === input;
    setBusy(true);
    setError("");
    try {
      await action(current);
    } catch {
      if (current()) setError(t`Could not update host`);
    } finally {
      if (generation.current === started) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <label
        htmlFor={`${id}-host`}
        className="flex min-h-11 items-center justify-between gap-3 text-sm"
      >
        <Trans>Host</Trans>
        <NativeSelect
          id={`${id}-host`}
          aria-label={t`Host`}
          value={value ?? ""}
          onChange={(event) => {
            intent.current++;
            onChange(event.target.value || null);
          }}
        >
          <NativeSelectOption value="">{t`Local host`}</NativeSelectOption>
          {hosts.map((host) => (
            <NativeSelectOption key={host.id} value={host.id} disabled={!!host.revokedAt}>
              {host.name}
              {host.revokedAt ? t` (revoked)` : ""}
            </NativeSelectOption>
          ))}
          {value && !selected ? (
            <NativeSelectOption value={value} disabled>{t`Unavailable host`}</NativeSelectOption>
          ) : null}
        </NativeSelect>
      </label>
      {selected ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{selected.endpoint}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async (current) => {
                const next = await rpc.hosts.check({ hostId: selected.id });
                if (!current()) return;
                setHosts((rows) => rows.map((row) => (row.id === next.id ? next : row)));
              })
            }
          >{t`Check`}</Button>
          <span role="status">{selected.healthStatus}</span>
          {selected.revocationPending ? (
            <span>
              <Trans>Stopping work</Trans>
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || (!!selected.revokedAt && !selected.revocationPending)}
            onClick={() =>
              void run(async (current) => {
                const next = await rpc.hosts.revoke({ hostId: selected.id });
                if (!current()) return;
                setHosts((rows) => rows.map((row) => (row.id === next.id ? next : row)));
              })
            }
          >{t`Revoke`}</Button>
        </div>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          intent.current++;
          setOpen(!open);
          setToken("");
        }}
      >{t`Register host`}</Button>
      {open ? (
        <div className="space-y-2">
          <Input
            aria-label={t`Host name`}
            placeholder={t`Host name`}
            value={name}
            onChange={(event) => {
              intent.current++;
              setName(event.target.value);
            }}
          />
          <Input
            aria-label={t`Host URL`}
            placeholder="https://host.example.test"
            value={endpoint}
            onChange={(event) => {
              intent.current++;
              setEndpoint(event.target.value);
            }}
          />
          <Input
            aria-label={t`Host token`}
            placeholder={t`Host token`}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => {
              intent.current++;
              setToken(event.target.value);
            }}
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(event) => {
                intent.current++;
                setTrusted(event.target.checked);
              }}
            />
            <Trans>I trust this host to run commands and access project files.</Trans>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy || !trusted || !name.trim() || !endpoint.trim() || !token.trim()}
            onClick={() =>
              void run(async (current) => {
                const next = await rpc.hosts.register({ name, endpoint, token, trusted: true });
                if (!current()) return;
                setHosts((rows) => [...rows, next]);
                onChange(next.id);
                setToken("");
                setOpen(false);
              })
            }
          >{t`Register`}</Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
