import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationEngineState } from "@rakazo/contracts";
import { Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useId } from "react";

type Generation = NonNullable<
  NonNullable<ConversationEngineState["inspection"]>["debug"]
>["generation"];
export function ConversationEngineGeneration({
  generation,
  tier,
  disabled,
  onChange,
}: {
  generation: Generation;
  tier: string | undefined;
  disabled: boolean;
  onChange: (tier: string | undefined) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  return (
    <div className="min-w-0 space-y-3">
      <label className="text-sm" htmlFor={id}>
        <Trans>Model tier</Trans>
      </label>
      {generation ? (
        <NativeSelect
          id={id}
          disabled={disabled}
          value={tier ?? ""}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <NativeSelectOption value="">{t`Engine default`}</NativeSelectOption>
          {tier && !generation.profiles.includes(tier) ? (
            <NativeSelectOption value={tier} disabled>
              {tier}
            </NativeSelectOption>
          ) : null}
          {generation.profiles.map((profile) => (
            <NativeSelectOption key={profile} value={profile}>
              {profile}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <>
          <Input
            id={id}
            disabled={disabled}
            value={tier ?? ""}
            maxLength={32}
            placeholder={t`Engine default`}
            onChange={(event) => onChange(event.target.value || undefined)}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Deployment model details are unavailable.</Trans>
          </p>
        </>
      )}
      {generation?.tasks.length ? (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              <Trans>Deployment generation settings</Trans>
            </caption>
            <thead className="text-muted-foreground">
              <tr>
                <th className="p-2">
                  <Trans>Task</Trans>
                </th>
                <th className="p-2">
                  <Trans>Models</Trans>
                </th>
                <th className="p-2">
                  <Trans>Fallback</Trans>
                </th>
                <th className="p-2">
                  <Trans>Temperature</Trans>
                </th>
                <th className="p-2">
                  <Trans>Token limit</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {generation.tasks.map((task) => (
                <tr key={task.name} className="border-t border-border">
                  <td className="p-2">{task.name}</td>
                  <td className="p-2">{task.models.join(", ") || t`Not available`}</td>
                  <td className="p-2">{task.fallback.join(", ") || t`None`}</td>
                  <td className="p-2">{task.temperature ?? t`Not available`}</td>
                  <td className="p-2">{task.maxTokens ?? t`Not available`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <Trans>Sampling and model routes are managed by the Eros deployment.</Trans>
      </p>
    </div>
  );
}
