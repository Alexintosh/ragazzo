import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { NativeRuntimeCapabilities } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { NativeRuntimeSetup } from "./native-runtime-setup";
import { ProjectFolderPicker } from "./project-folder-picker";
import { RegisteredHostPicker } from "./registered-host-picker";

export type BotRuntimeSettingsValue = Pick<
  Bot,
  "runtimeKind" | "executionTarget" | "runtimePermission" | "projectPath" | "registeredHostId"
>;

export function BotRuntimeSettings({
  value,
  onChange,
}: {
  value: BotRuntimeSettingsValue;
  onChange: (value: BotRuntimeSettingsValue) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const rpc = useSpaceRpc();
  const [environment, setEnvironment] = useState<{
    client: typeof rpc;
    provider?: string | null;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    void rpc.me({}).then(
      (me) => {
        if (active) setEnvironment({ client: rpc, provider: me.sandboxProvider });
      },
      () => {
        if (active) setEnvironment({ client: rpc, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  const currentEnvironment = environment?.client === rpc ? environment : undefined;
  const dockerAvailable = currentEnvironment?.provider === "docker";
  const dockerHint = currentEnvironment?.failed
    ? t`Could not check Docker availability.`
    : !currentEnvironment
      ? t`Checking Docker availability…`
      : t`Docker is not enabled on this deployment.`;
  return (
    <div className="space-y-3">
      <label
        htmlFor={`${id}-runtime`}
        className="flex min-h-11 items-center justify-between gap-3 text-sm"
      >
        <span>
          <Trans>Agent</Trans>
        </span>
        <NativeSelect
          id={`${id}-runtime`}
          aria-label={t`Agent`}
          value={value.runtimeKind}
          onChange={(event) => {
            const runtimeKind = event.target.value as Bot["runtimeKind"];
            onChange({
              ...value,
              runtimeKind,
              executionTarget: runtimeKind !== "pi" ? "host" : value.executionTarget,
              ...(runtimeKind === "pi"
                ? { runtimePermission: "workspace", projectPath: null }
                : {}),
            });
          }}
        >
          <NativeSelectOption value="pi">Pi</NativeSelectOption>
          {Object.entries(NativeRuntimeCapabilities).map(([kind, capability]) => (
            <NativeSelectOption key={kind} value={kind}>
              {capability.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label
        htmlFor={`${id}-target`}
        className="flex min-h-11 items-center justify-between gap-3 text-sm"
      >
        <Trans>Run on</Trans>
        <NativeSelect
          id={`${id}-target`}
          aria-label={t`Run on`}
          value={value.executionTarget}
          onChange={(event) => {
            if (event.target.value === "docker" && !dockerAvailable) return;
            onChange({
              ...value,
              executionTarget: event.target.value as Bot["executionTarget"],
              registeredHostId: event.target.value === "host" ? value.registeredHostId : null,
            });
          }}
        >
          {value.runtimeKind === "pi" ? (
            <>
              <NativeSelectOption value="default">{t`Default environment`}</NativeSelectOption>
              <NativeSelectOption value="docker" disabled={!dockerAvailable}>
                {t`Docker sandbox`}
              </NativeSelectOption>
            </>
          ) : null}
          <NativeSelectOption value="host">{t`Host machine`}</NativeSelectOption>
        </NativeSelect>
      </label>
      {value.runtimeKind === "pi" && !dockerAvailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          {dockerHint}
        </p>
      ) : null}
      {value.executionTarget === "host" ? (
        <RegisteredHostPicker
          value={value.registeredHostId ?? null}
          onChange={(registeredHostId) => onChange({ ...value, registeredHostId })}
        />
      ) : null}
      {value.runtimeKind !== "pi" ? (
        <NativeRuntimeSetup kind={value.runtimeKind} hostId={value.registeredHostId ?? null} />
      ) : null}
      {value.runtimeKind !== "pi" ? (
        <ProjectFolderPicker
          key={value.registeredHostId ?? "local"}
          id={`${id}-project`}
          hostId={value.registeredHostId ?? null}
          value={value.projectPath}
          onChange={(projectPath) => onChange({ ...value, projectPath })}
        />
      ) : null}
      {value.runtimeKind !== "pi" ? (
        <label
          htmlFor={`${id}-permission`}
          className="flex min-h-11 items-center justify-between gap-3 text-sm"
        >
          <Trans>Access</Trans>
          <NativeSelect
            id={`${id}-permission`}
            aria-label={t`Access`}
            value={value.runtimePermission}
            onChange={(event) =>
              onChange({
                ...value,
                runtimePermission: event.target.value as Bot["runtimePermission"],
              })
            }
          >
            <NativeSelectOption
              disabled={value.runtimeKind !== "codex"}
              value="workspace"
            >{t`Workspace`}</NativeSelectOption>
            <NativeSelectOption value="full">{t`Full access`}</NativeSelectOption>
          </NativeSelect>
        </label>
      ) : null}
    </div>
  );
}

export function BotRuntimeStatus({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const status = useQuery({
    ...queries.bots.executionStatus.queryOptions({ input: { botId } }),
    refetchOnMount: "always",
  });
  const data = status.data;
  const message = status.isError
    ? t`Could not check runtime`
    : !data
      ? t`Checking runtime…`
      : data.reason === "host-unavailable"
        ? t`Start the host with host access enabled.`
        : data.reason === "cli-unavailable"
          ? t`Install the runtime on the host.`
          : data.reason === "login-required" || !data.authenticated
            ? t`Sign in to the runtime on the host.`
            : !data.available
              ? t`Runtime unavailable`
              : t`Runtime ready`;
  return (
    <div
      className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
      role="status"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={status.isFetching}
        onClick={() => void status.refetch()}
      >{t`Refresh`}</Button>
    </div>
  );
}
