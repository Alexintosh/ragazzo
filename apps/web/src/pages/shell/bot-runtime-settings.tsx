import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { NativeRuntimeCapabilities } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useSpaceQueries } from "../../lib/query";
import { NativeRuntimeSetup } from "./native-runtime-setup";
import { ProjectFolderPicker } from "./project-folder-picker";
import { RegisteredHostPicker } from "./registered-host-picker";

export type BotRuntimeSettingsValue = Pick<
  Bot,
  "runtimeKind" | "executionTarget" | "runtimePermission" | "projectPath" | "registeredHostId"
>;

/** Incomplete selections stay local until the operator chooses a host and project. */
export function useBotRuntimeSettingsError(value: BotRuntimeSettingsValue) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const me = useQuery({ ...queries.me.queryOptions(), refetchOnMount: "always" });
  if (value.executionTarget === "host" && !value.registeredHostId) {
    if (me.isPending) return t`Checking host availability…`;
    if (me.data?.localHostConfigured !== true)
      return t`Select a registered host, such as your Mac.`;
  }
  if (value.runtimeKind !== "pi" && !value.projectPath?.trim())
    return t`Choose a project folder on the selected host.`;
  return null;
}

export function BotRuntimeSettings({
  value,
  onChange,
}: {
  value: BotRuntimeSettingsValue;
  onChange: (value: BotRuntimeSettingsValue) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const queries = useSpaceQueries();
  const environment = useQuery({ ...queries.me.queryOptions(), refetchOnMount: "always" });
  const dockerAvailable = environment.data?.sandboxProvider === "docker";
  const localHostAvailable = environment.data?.localHostConfigured === true;
  const hostReady = Boolean(value.registeredHostId) || localHostAvailable;
  const selectionError = useBotRuntimeSettingsError(value);
  const dockerHint = environment.isError
    ? t`Could not check Docker availability.`
    : environment.isPending
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
          localHostAvailable={localHostAvailable}
          onChange={(registeredHostId) =>
            onChange({
              ...value,
              registeredHostId,
              projectPath:
                registeredHostId === (value.registeredHostId ?? null) ? value.projectPath : null,
            })
          }
        />
      ) : null}
      {value.runtimeKind !== "pi" && hostReady ? (
        <NativeRuntimeSetup kind={value.runtimeKind} hostId={value.registeredHostId ?? null} />
      ) : null}
      {value.runtimeKind !== "pi" && hostReady ? (
        <ProjectFolderPicker
          key={value.registeredHostId ?? "local"}
          id={`${id}-project`}
          hostId={value.registeredHostId ?? null}
          value={value.projectPath}
          onChange={(projectPath) => onChange({ ...value, projectPath })}
        />
      ) : null}
      {selectionError ? (
        <p role="status" className="text-xs text-muted-foreground">
          {selectionError}
        </p>
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
      {value.runtimeKind !== "pi" ? (
        <div role="note" className="space-y-1 text-xs text-muted-foreground">
          <p>
            {value.runtimePermission === "full"
              ? t`Full access allows file changes and commands outside the project folder.`
              : t`Workspace limits file writes. It does not limit all reads or network access.`}
          </p>
        </div>
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
