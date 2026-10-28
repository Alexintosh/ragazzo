import { Trans, useLingui } from "@lingui/react/macro";
import type { RoleplayCharacter, RoleplayLorebookEntry } from "@rakazo/contracts";
import { RoleplayCharacterSchema } from "@rakazo/contracts";
import {
  createRoleplayLorebook,
  createRoleplayLorebookEntry,
  parseRoleplayInteger,
} from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption, Switch, Textarea } from "@rakazo/ui-web";
import { ChevronDown, Plus, X } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../lib/user-error";

type TextField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "firstMessage"
  | "exampleDialogue"
  | "systemPrompt"
  | "postHistoryInstructions";
type Errors = Record<string, string>;
const busyStatuses = new Set(["queued", "leased", "running", "waiting_input", "waiting_takeover"]);
const clone = (character: RoleplayCharacter): RoleplayCharacter => structuredClone(character);

/** Explicit character-only saves never submit unrelated profile or runtime drafts. */
export function RoleplaySettings({
  character,
  botId,
  status,
  onSave,
}: {
  character: RoleplayCharacter;
  botId: string;
  status: string;
  onSave: (character: RoleplayCharacter, expected: RoleplayCharacter) => Promise<void>;
}) {
  // A new bot owns a new draft even if this component is reused outside BotSettings.
  return <CharacterEditor key={botId} character={character} status={status} onSave={onSave} />;
}

function CharacterEditor({
  character,
  status,
  onSave,
}: Omit<Parameters<typeof RoleplaySettings>[0], "botId">) {
  const { t } = useLingui();
  const id = useId();
  const [draft, setDraft] = useState(() => clone(character));
  const [baseline, setBaseline] = useState(() => JSON.stringify(character));
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dirty = JSON.stringify(draft) !== baseline || Object.keys(numbers).length > 0;
  const busy = busyStatuses.has(status);
  const incoming = useRef(character);
  useEffect(() => {
    if (incoming.current === character) return;
    incoming.current = character;
    if (!dirty && !savingRef.current) {
      setDraft(clone(character));
      setBaseline(JSON.stringify(character));
      setNumbers({});
      setErrors({});
    }
  }, [character, dirty]);

  function update(patch: Partial<RoleplayCharacter>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFailure(null);
  }
  function book(patch: Partial<NonNullable<RoleplayCharacter["lorebook"]>>) {
    if (draft.lorebook) update({ lorebook: { ...draft.lorebook, ...patch } });
  }
  function entry(index: number, patch: Partial<RoleplayLorebookEntry>) {
    book({
      entries: draft.lorebook!.entries.map((value, i) =>
        i === index ? { ...value, ...patch } : value,
      ),
    });
  }
  function numeric(path: string, value: number, label: string, min: number, max: number) {
    return (
      <Field id={`${id}-${path}`} label={label} error={errors[path]}>
        <Input
          id={`${id}-${path}`}
          type="text"
          inputMode="numeric"
          value={numbers[path] ?? String(value)}
          aria-invalid={Boolean(errors[path])}
          aria-describedby={errors[path] ? `${id}-${path}-error` : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            setNumbers((current) => {
              const next = { ...current };
              if (raw === String(value)) delete next[path];
              else next[path] = raw;
              return next;
            });
            setFailure(null);
          }}
        />
        <span className="text-xs text-muted-foreground">
          {min}–{max}
        </span>
      </Field>
    );
  }
  function text(field: TextField, label: string) {
    const props = {
      id: `${id}-${field}`,
      value: draft[field],
      maxLength: field === "name" ? 500 : 100_000,
      "aria-invalid": Boolean(errors[field]),
      "aria-describedby": errors[field] ? `${id}-${field}-error` : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        update({ [field]: event.target.value }),
    };
    return (
      <Field id={props.id} label={label} error={errors[field]}>
        {field === "name" ? (
          <Input {...props} />
        ) : (
          <Textarea {...props} className="min-h-24 max-h-96 resize-y field-sizing-fixed" />
        )}
      </Field>
    );
  }
  async function save() {
    if (savingRef.current || busy) return;
    const candidate = clone(draft);
    for (const [path, raw] of Object.entries(numbers)) {
      const value = parseRoleplayInteger(raw);
      if (!candidate.lorebook) continue;
      if (path === "lorebook.scanDepth") candidate.lorebook.scanDepth = value;
      else if (path === "lorebook.tokenBudget") candidate.lorebook.tokenBudget = value;
      else {
        const index = Number(path.split(".")[2]);
        if (candidate.lorebook.entries[index])
          candidate.lorebook.entries[index]!.insertionOrder = value;
      }
    }
    const result = RoleplayCharacterSchema.safeParse(candidate);
    if (!result.success) {
      const next: Errors = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        next[path] =
          path === "lorebook.scanDepth"
            ? t`Enter a whole number from 0 to 100.`
            : path === "lorebook.tokenBudget"
              ? t`Enter a whole number from 0 to 32768.`
              : path.endsWith(".insertionOrder")
                ? t`Enter a whole number from -100000 to 100000.`
                : path === "name"
                  ? t`Enter a character name (1–500 characters).`
                  : path === ""
                    ? t`Character content must be at most 1 MB.`
                    : t`This field exceeds the character limit.`;
      }
      setErrors(next);
      setFailure(t`Check the highlighted fields.`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    setErrors({});
    try {
      // Match the API's canonical character so the next save compares the accepted baseline.
      await onSave(result.data, JSON.parse(baseline) as RoleplayCharacter);
      setDraft(result.data);
      setBaseline(JSON.stringify(result.data));
      setNumbers({});
    } catch (error) {
      setFailure(errorText(error, t`Could not save character`));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function discard() {
    setDraft(clone(character));
    setBaseline(JSON.stringify(character));
    setNumbers({});
    setErrors({});
    setFailure(null);
  }

  return (
    <section
      aria-label={t`Roleplay settings`}
      className="mt-6 space-y-1"
      data-testid="roleplay-settings"
    >
      <fieldset disabled={saving} className="min-w-0 space-y-1">
        <Disclosure
          label={t`Character`}
          open
          error={Boolean(errors.name || errors.description || errors.personality)}
        >
          {text("name", t`Character name`)}
          {text("description", t`Description`)}
          {text("personality", t`Personality`)}
        </Disclosure>
        <Disclosure
          label={t`Story`}
          error={Boolean(errors.scenario || errors.firstMessage || errors.exampleDialogue)}
        >
          {text("scenario", t`Scenario`)}
          {text("firstMessage", t`First message`)}
          <p className="text-xs text-muted-foreground">
            <Trans>The first message is used when a story starts or is reset.</Trans>
          </p>
          {text("exampleDialogue", t`Dialogue examples`)}
        </Disclosure>
        <Disclosure
          label={t`Narrative instructions`}
          error={Boolean(errors.systemPrompt || errors.postHistoryInstructions)}
        >
          {text("systemPrompt", t`System prompt`)}
          {text("postHistoryInstructions", t`Post-history instructions`)}
        </Disclosure>
        <Disclosure
          label={t`Lorebook`}
          error={Object.keys(errors).some((key) => key.startsWith("lorebook"))}
        >
          {draft.lorebook ? (
            <>
              <Field
                id={`${id}-book-name`}
                label={t`Lorebook name`}
                error={errors["lorebook.name"]}
              >
                <Input
                  id={`${id}-book-name`}
                  value={draft.lorebook.name}
                  maxLength={500}
                  onChange={(event) => book({ name: event.target.value })}
                />
              </Field>
              <Field
                id={`${id}-book-description`}
                label={t`Lorebook description`}
                error={errors["lorebook.description"]}
              >
                <Textarea
                  id={`${id}-book-description`}
                  value={draft.lorebook.description}
                  maxLength={100_000}
                  className="max-h-96 field-sizing-fixed"
                  onChange={(event) => book({ description: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                {numeric("lorebook.scanDepth", draft.lorebook.scanDepth, t`Scan depth`, 0, 100)}
                {numeric(
                  "lorebook.tokenBudget",
                  draft.lorebook.tokenBudget,
                  t`Token budget`,
                  0,
                  32768,
                )}
              </div>
              <div className="space-y-2">
                {draft.lorebook.entries.map((value, index) => (
                  <Disclosure
                    key={index}
                    label={value.keys.filter(Boolean).join(", ") || t`Entry ${index + 1}`}
                    inset
                    error={Object.keys(errors).some((key) =>
                      key.startsWith(`lorebook.entries.${index}.`),
                    )}
                    badge={
                      !value.enabled ? t`Disabled` : value.constant ? t`Always active` : undefined
                    }
                  >
                    <SwitchField
                      label={t`Enabled`}
                      checked={value.enabled}
                      onChange={(enabled) => entry(index, { enabled })}
                    />
                    <Field
                      id={`${id}-entry-${index}-content`}
                      label={t`Content`}
                      error={errors[`lorebook.entries.${index}.content`]}
                    >
                      <Textarea
                        id={`${id}-entry-${index}-content`}
                        value={value.content}
                        maxLength={100_000}
                        className="min-h-24 max-h-96 field-sizing-fixed"
                        onChange={(event) => entry(index, { content: event.target.value })}
                      />
                    </Field>
                    <KeyFields
                      label={t`Primary keys`}
                      values={value.keys}
                      onChange={(keys) => entry(index, { keys })}
                      error={errors[`lorebook.entries.${index}.keys`]}
                    />
                    <KeyFields
                      label={t`Secondary keys`}
                      values={value.secondaryKeys}
                      onChange={(secondaryKeys) => entry(index, { secondaryKeys })}
                      error={errors[`lorebook.entries.${index}.secondaryKeys`]}
                    />
                    <SwitchField
                      label={t`Always active`}
                      checked={value.constant}
                      onChange={(constant) => entry(index, { constant })}
                    />
                    <SwitchField
                      label={t`Require secondary match`}
                      checked={value.selective}
                      onChange={(selective) => entry(index, { selective })}
                    />
                    <SwitchField
                      label={t`Case sensitive`}
                      checked={value.caseSensitive}
                      onChange={(caseSensitive) => entry(index, { caseSensitive })}
                    />
                    {numeric(
                      `lorebook.entries.${index}.insertionOrder`,
                      value.insertionOrder,
                      t`Insertion order`,
                      -100000,
                      100000,
                    )}
                    <Field id={`${id}-entry-${index}-position`} label={t`Position`}>
                      <NativeSelect
                        id={`${id}-entry-${index}-position`}
                        value={value.position}
                        onChange={(event) =>
                          entry(index, {
                            position: event.target.value as RoleplayLorebookEntry["position"],
                          })
                        }
                      >
                        <NativeSelectOption value="before_char">
                          <Trans>Before character</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="after_char">
                          <Trans>After character</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <Button
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => {
                        book({ entries: draft.lorebook!.entries.filter((_, i) => i !== index) });
                        // Numeric paths use entry indices; shift pending edits along with the rows.
                        setNumbers((current) =>
                          Object.fromEntries(
                            Object.entries(current).flatMap(([path, raw]) => {
                              if (!path.startsWith("lorebook.entries.")) return [[path, raw]];
                              const i = Number(path.split(".")[2]);
                              return i === index
                                ? []
                                : [
                                    [
                                      `lorebook.entries.${i > index ? i - 1 : i}.insertionOrder`,
                                      raw,
                                    ],
                                  ];
                            }),
                          ),
                        );
                        setErrors({});
                      }}
                    >
                      <Trans>Remove entry</Trans>
                    </Button>
                  </Disclosure>
                ))}
              </div>
              {errors["lorebook.entries"] ? (
                <p role="alert" className="text-xs text-destructive">
                  {errors["lorebook.entries"]}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  variant="outline"
                  disabled={draft.lorebook.entries.length >= 500}
                  onClick={() =>
                    book({
                      entries: [
                        ...draft.lorebook!.entries,
                        createRoleplayLorebookEntry(draft.lorebook!.entries.length),
                      ],
                    })
                  }
                >
                  <Plus aria-hidden="true" className="size-4" />
                  <Trans>Add entry</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    update({ lorebook: null });
                    setNumbers({});
                    setErrors({});
                  }}
                >
                  <Trans>Remove lorebook</Trans>
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => update({ lorebook: createRoleplayLorebook() })}
            >
              <Plus aria-hidden="true" className="size-4" />
              <Trans>Add lorebook</Trans>
            </Button>
          )}
        </Disclosure>
      </fieldset>
      <div className="space-y-3 pt-4">
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {errors[""] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors[""]}
          </p>
        ) : null}
        {dirty ? (
          <>
            <p className="text-xs text-muted-foreground">
              {busy
                ? t`Stop the current reply before saving character changes.`
                : t`Changes apply to the next reply. Story history and memory are kept.`}
            </p>
            <div className="flex gap-2">
              <Button disabled={saving || busy} onClick={() => void save()}>
                {saving ? t`Saving…` : t`Save changes`}
              </Button>
              <Button variant="ghost" disabled={saving} onClick={discard}>
                <Trans>Discard</Trans>
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Disclosure({
  label,
  badge,
  open,
  inset,
  error,
  children,
}: {
  label: string;
  badge?: string;
  open?: boolean;
  inset?: boolean;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={open || error || undefined}
      className={
        inset ? "group rounded-lg border border-border px-3" : "group border-b border-border"
      }
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden [[open]>&>svg]:rotate-0">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge ? (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{badge}</span>
        ) : null}
        {error ? <span className="size-1.5 shrink-0 rounded-full bg-destructive" /> : null}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform -rotate-90 motion-reduce:transition-none"
        />
      </summary>
      <div className="space-y-4 pb-5 pt-1">{children}</div>
    </details>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function KeyFields({
  label,
  values,
  onChange,
  error,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
}) {
  const { t } = useLingui();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm">{label}</legend>
      {values.map((value, index) => (
        <div key={index} className="flex gap-2">
          <Input
            aria-label={t`${label} ${index + 1}`}
            value={value}
            maxLength={500}
            onChange={(event) =>
              onChange(values.map((key, i) => (i === index ? event.target.value : key)))
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`Remove ${label} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={values.length >= 100}
        onClick={() => onChange([...values, ""])}
      >
        <Plus aria-hidden="true" className="size-3.5" />
        <Trans>Add key</Trans>
      </Button>
    </fieldset>
  );
}
