import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationEngineState } from "@rakazo/contracts";
import { ConversationEngineSettingsSchema } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";
import { EngineDisclosure as Disclosure, EngineProfile } from "./conversation-engine-fields";
import { ConversationEngineGeneration } from "./conversation-engine-generation";

type SettingsState = ConversationEngineState["settings"];
type Settings = SettingsState["values"];
const memoryScopes = [
  "full",
  "neutral_and_relationship",
  "relationship_only",
  "neutral_only",
  "insights_only",
  "none",
] as const;
const affinityScopes = ["full", "bond_and_chemistry", "bond", "chemistry", "none"] as const;

export function ConversationEngineSettings({
  state,
  busy,
  onSave,
  inventory,
}: {
  inventory?: ReactNode;
  state: ConversationEngineState;
  busy: boolean;
  onSave: (settings: SettingsState, values: Settings) => Promise<SettingsState>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [base, setBase] = useState(state.settings);
  const [draft, setDraft] = useState(state.settings.values);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.values);
  const stale = dirty && base.revision !== state.settings.revision;
  useEffect(() => {
    if (!dirty && !inFlight.current) {
      setBase(state.settings);
      setDraft(state.settings.values);
    }
  }, [state.settings, dirty]);
  function update(patch: Partial<Settings>) {
    setDraft({ ...draft, ...patch });
    setFailure(null);
  }
  async function save() {
    if (busy || inFlight.current || stale) return;
    const parsed = ConversationEngineSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setFailure(
        t`Use lowercase letters, numbers and underscores for tier and trait tags, and single-line trait guidance.`,
      );
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const next = await onSave(base, parsed.data);
      if (active.current) {
        setBase(next);
        setDraft(next.values);
      }
    } catch (error) {
      if (active.current) setFailure(errorText(error, t`Could not save Eros settings`));
    } finally {
      inFlight.current = false;
      if (active.current) setSaving(false);
    }
  }
  const disabled = busy || saving;
  const scopeLabels: Record<string, string> = {
    full: t`Full`,
    neutral_and_relationship: t`Neutral and relationship`,
    relationship_only: t`Relationship only`,
    neutral_only: t`Neutral only`,
    insights_only: t`Insights only`,
    none: t`None`,
    bond_and_chemistry: t`Bond and chemistry`,
    bond: t`Bond`,
    chemistry: t`Chemistry`,
  };
  function scope(key: "memoryScope" | "affinityScope", label: string, options: readonly string[]) {
    const value = draft[key];
    return (
      <div className="space-y-1">
        <label className="text-sm" htmlFor={`${id}-${key}`}>
          {label}
        </label>
        <NativeSelect
          id={`${id}-${key}`}
          disabled={disabled}
          value={Array.isArray(value) ? "custom" : (value ?? "")}
          onChange={(event) =>
            update({
              [key]: event.target.value === "custom" ? [] : event.target.value || undefined,
            })
          }
        >
          <NativeSelectOption value="">{t`Engine default`}</NativeSelectOption>
          {key === "affinityScope" ? (
            <NativeSelectOption value="custom">{t`Custom axes`}</NativeSelectOption>
          ) : null}
          {options.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {scopeLabels[option]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {Array.isArray(value) ? (
          <div className="grid grid-cols-2 gap-2 pt-2">
            {(
              [
                ["warmth", t`Warmth`],
                ["trust", t`Trust`],
                ["intrigue", t`Intrigue`],
                ["intimacy", t`Intimacy`],
                ["patience", t`Patience`],
                ["tension", t`Tension`],
              ] as const
            ).map(([axis, axisLabel]) => (
              <div key={axis} className="flex items-center gap-2">
                <Switch
                  id={`${id}-include-${axis}`}
                  disabled={disabled}
                  checked={value.includes(axis)}
                  onCheckedChange={(checked) =>
                    update({
                      affinityScope: checked
                        ? [...value, axis]
                        : value.filter((current) => current !== axis),
                    })
                  }
                />
                <label className="text-sm" htmlFor={`${id}-include-${axis}`}>
                  {axisLabel}
                </label>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const profile = state.inspection?.userProfile;
  return (
    <div className="space-y-3" data-testid="conversation-engine-settings">
      <Disclosure label={t`Relationship evolution`}>
        {scope("affinityScope", t`Relationship context`, affinityScopes)}
      </Disclosure>
      <Disclosure label={t`User insights`}>
        {scope("memoryScope", t`Memory context`, memoryScopes)}
        {profile ? (
          <div className="space-y-3">
            <EngineProfile profile={profile} />
            <p className="text-xs text-muted-foreground">
              <Trans>Observed by Eros.</Trans>
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No user insights available.</Trans>
          </p>
        )}
      </Disclosure>
      <Disclosure label={t`Behavior traits`}>
        <div className="space-y-3">
          {(draft.promptTraits ?? []).map((trait, index) => (
            <fieldset key={index} disabled={disabled} className="space-y-2">
              <label className="text-sm" htmlFor={`${id}-tag-${index}`}>
                <Trans>Trait tag</Trans>
              </label>
              <Input
                id={`${id}-tag-${index}`}
                value={trait.tag}
                maxLength={32}
                onChange={(event) =>
                  update({
                    promptTraits: draft.promptTraits!.map((current, i) =>
                      i === index ? { ...current, tag: event.target.value } : current,
                    ),
                  })
                }
              />
              <label className="text-sm" htmlFor={`${id}-trait-${index}`}>
                <Trans>Trait guidance</Trans>
              </label>
              <Input
                id={`${id}-trait-${index}`}
                value={trait.text}
                maxLength={2000}
                onChange={(event) =>
                  update({
                    promptTraits: draft.promptTraits!.map((current, i) =>
                      i === index ? { ...current, text: event.target.value } : current,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({ promptTraits: draft.promptTraits!.filter((_, i) => i !== index) })
                }
              >
                <Trans>Remove trait</Trans>
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || (draft.promptTraits?.length ?? 0) >= 8}
            onClick={() =>
              update({ promptTraits: [...(draft.promptTraits ?? []), { tag: "", text: "" }] })
            }
          >
            <Trans>Add trait</Trans>
          </Button>
        </div>
      </Disclosure>
      <Disclosure label={t`Inventory and outfit`}>
        <label className="text-sm" htmlFor={`${id}-outfit`}>
          <Trans>Outfit</Trans>
        </label>
        <Input
          id={`${id}-outfit`}
          disabled={disabled}
          value={draft.outfit ?? ""}
          maxLength={64}
          placeholder={t`Engine default`}
          onChange={(event) => update({ outfit: event.target.value || undefined })}
        />
        {inventory}
      </Disclosure>
      <Disclosure label={t`Model generation`}>
        <ConversationEngineGeneration
          generation={state.inspection?.debug?.generation}
          tier={draft.tier}
          disabled={disabled}
          onChange={(tier) => update({ tier })}
        />
      </Disclosure>
      {stale ? (
        <p role="status" className="text-xs text-muted-foreground">
          <Trans>Settings changed. Discard edits to use the latest values.</Trans>
        </p>
      ) : null}
      {dirty ? (
        <div className="flex gap-2">
          <Button disabled={disabled || stale} onClick={() => void save()}>
            <Trans>Save settings</Trans>
          </Button>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setBase(state.settings);
              setDraft(state.settings.values);
              setFailure(null);
            }}
          >
            <Trans>Discard settings</Trans>
          </Button>
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
