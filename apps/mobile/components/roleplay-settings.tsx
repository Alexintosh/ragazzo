import type { RoleplayCharacter, RoleplayLorebookEntry } from "@rakazo/contracts";
import { RoleplayCharacterSchema } from "@rakazo/contracts";
import {
  createRoleplayLorebook,
  createRoleplayLorebookEntry,
  parseRoleplayInteger,
} from "@rakazo/core";
import type { ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
import { Chevron } from "./row-accessories";

type Lorebook = NonNullable<RoleplayCharacter["lorebook"]>;
type EntryDraft = Omit<RoleplayLorebookEntry, "insertionOrder"> & { insertionOrder: string };
type Draft = Omit<RoleplayCharacter, "lorebook"> & {
  lorebook:
    | (Omit<Lorebook, "scanDepth" | "tokenBudget" | "entries"> & {
        scanDepth: string;
        tokenBudget: string;
        entries: EntryDraft[];
      })
    | null;
};

function draftFrom(character: RoleplayCharacter): Draft {
  return {
    ...character,
    lorebook: character.lorebook
      ? {
          ...character.lorebook,
          scanDepth: String(character.lorebook.scanDepth),
          tokenBudget: String(character.lorebook.tokenBudget),
          entries: character.lorebook.entries.map((entry) => ({
            ...entry,
            insertionOrder: String(entry.insertionOrder),
          })),
        }
      : null,
  };
}

function characterFrom(draft: Draft) {
  return {
    ...draft,
    lorebook: draft.lorebook
      ? {
          ...draft.lorebook,
          scanDepth: parseRoleplayInteger(draft.lorebook.scanDepth),
          tokenBudget: parseRoleplayInteger(draft.lorebook.tokenBudget),
          entries: draft.lorebook.entries.map((entry) => ({
            ...entry,
            insertionOrder: parseRoleplayInteger(entry.insertionOrder),
          })),
        }
      : null,
  };
}

export type RoleplaySettingsHandle = { save: () => Promise<boolean> };

/** The bot id keys this component; refreshes may update the saved baseline but never a dirty draft. */
export function RoleplaySettings({
  character,
  disabled = false,
  onSave,
  onStateChange,
  ref,
}: {
  character: RoleplayCharacter;
  disabled?: boolean;
  onSave: (character: RoleplayCharacter, expected: RoleplayCharacter) => Promise<RoleplayCharacter>;
  onStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
  ref?: Ref<RoleplaySettingsHandle>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [baseline, setBaseline] = useState(character);
  const [draft, setDraft] = useState(() => draftFrom(character));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const lastReceivedCharacter = useRef(character);
  const [showErrors, setShowErrors] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(baseline));
  const inactive = pending || disabled;

  useEffect(() => {
    if (lastReceivedCharacter.current === character) return;
    lastReceivedCharacter.current = character;
    if (!dirty && !saving.current) {
      setBaseline(character);
      setDraft(draftFrom(character));
    }
  }, [character, dirty]);
  useEffect(() => {
    onStateChange?.({ dirty, pending });
  }, [dirty, pending, onStateChange]);

  function update(change: Partial<Draft>) {
    setDraft((value) => ({ ...value, ...change }));
  }
  function updateBook(change: Partial<NonNullable<Draft["lorebook"]>>) {
    setDraft((value) => ({
      ...value,
      lorebook: value.lorebook ? { ...value.lorebook, ...change } : null,
    }));
  }
  function updateEntry(index: number, change: Partial<EntryDraft>) {
    if (!draft.lorebook) return;
    updateBook({
      entries: draft.lorebook.entries.map((entry, current) =>
        current === index ? { ...entry, ...change } : entry,
      ),
    });
  }
  function discard() {
    // A refresh while editing becomes the baseline only after an explicit discard.
    setBaseline(character);
    setDraft(draftFrom(character));
    setErrors({});
    setFailure(null);
    setShowErrors(false);
  }
  async function save() {
    if (saving.current || disabled) return false;
    if (!dirty) return true;
    const parsed = RoleplayCharacterSchema.safeParse(characterFrom(draft));
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        const last = issue.path.at(-1);
        next[path] =
          last === "scanDepth" || last === "tokenBudget" || last === "insertionOrder"
            ? t("Enter a whole number from {min} to {max}.", {
                min: last === "insertionOrder" ? -100000 : 0,
                max: last === "scanDepth" ? 100 : last === "tokenBudget" ? 32768 : 100000,
              })
            : issue.message;
      }
      setErrors(next);
      setShowErrors(true);
      setFailure(null);
      return false;
    }
    saving.current = true;
    setPending(true);
    setErrors({});
    setFailure(null);
    try {
      const saved = await onSave(parsed.data, baseline);
      setBaseline(saved);
      setDraft(draftFrom(saved));
      setShowErrors(false);
      return true;
    } catch (error) {
      setFailure(errorText(error, t("Could not save character")));
      return false;
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  useImperativeHandle(ref, () => ({ save }));

  const field = (
    key: keyof Omit<Draft, "lorebook" | "alternateGreetings" | "conversationStyle" | "spontaneous">,
    label: string,
  ) => (
    <Field
      key={key}
      label={label}
      value={draft[key] ?? ""}
      error={errors[key]}
      disabled={inactive}
      multiline={key !== "name"}
      onChange={(value) => update({ [key]: value })}
    />
  );
  const book = draft.lorebook;
  return (
    <View style={styles.editor}>
      <Disclosure title={t("Character")} initiallyOpen forceOpen={showErrors}>
        <MenuPicker
          label={t("Conversation style")}
          value={draft.conversationStyle ?? "narrative"}
          choices={[
            { key: "narrative", label: t("Narrative"), disabled: inactive },
            { key: "chat", label: t("Chat"), disabled: inactive },
          ]}
          plain
          onChange={(conversationStyle) => {
            if (!inactive && (conversationStyle === "narrative" || conversationStyle === "chat"))
              update({ conversationStyle });
          }}
        />
        {draft.conversationStyle === "chat" ? (
          <>
            <View style={styles.switchRow}>
              <Text style={{ color: tokens.foreground, flex: 1 }}>{t("Spontaneous messages")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Spontaneous messages")}
                value={draft.spontaneous?.enabled ?? false}
                disabled={inactive}
                onValueChange={(enabled) =>
                  update({
                    spontaneous: {
                      frequency: "balanced",
                      allowLateNight: false,
                      ...draft.spontaneous,
                      enabled,
                    },
                  })
                }
              />
            </View>
            {draft.spontaneous?.enabled ? (
              <>
                <MenuPicker
                  label={t("Frequency")}
                  value={draft.spontaneous.frequency}
                  choices={[
                    { key: "gentle", label: t("Gentle"), disabled: inactive },
                    { key: "balanced", label: t("Balanced"), disabled: inactive },
                    { key: "frequent", label: t("Frequent"), disabled: inactive },
                  ]}
                  plain
                  onChange={(frequency) => {
                    if (
                      !inactive &&
                      (frequency === "gentle" ||
                        frequency === "balanced" ||
                        frequency === "frequent")
                    )
                      update({ spontaneous: { ...draft.spontaneous!, frequency } });
                  }}
                />
                <View style={styles.switchRow}>
                  <Text style={{ color: tokens.foreground, flex: 1 }}>
                    {t("Late-night messages")}
                  </Text>
                  <NativeSwitch
                    accessibilityLabel={t("Late-night messages")}
                    value={draft.spontaneous.allowLateNight}
                    disabled={inactive}
                    onValueChange={(allowLateNight) =>
                      update({ spontaneous: { ...draft.spontaneous!, allowLateNight } })
                    }
                  />
                </View>
              </>
            ) : null}
          </>
        ) : null}
        {field("name", t("Character name"))}
        {field("description", t("Character description"))}
        {field("personality", t("Personality"))}
      </Disclosure>
      <Disclosure title={t("Story")} forceOpen={showErrors}>
        {field("scenario", t("Scenario"))}
        {field("firstMessage", t("First message"))}
        {field("exampleDialogue", t("Dialogue examples"))}
      </Disclosure>
      <Disclosure title={t("Narrative instructions")} forceOpen={showErrors}>
        {field("systemPrompt", t("System prompt"))}
        {field("postHistoryInstructions", t("Post-history instructions"))}
      </Disclosure>
      <Disclosure title={t("Lorebook")} forceOpen={showErrors}>
        {book ? (
          <>
            <Field
              label={t("Lorebook name")}
              value={book.name}
              disabled={inactive}
              error={errors["lorebook.name"]}
              onChange={(name) => updateBook({ name })}
            />
            <Field
              label={t("Lorebook description")}
              value={book.description}
              multiline
              disabled={inactive}
              error={errors["lorebook.description"]}
              onChange={(description) => updateBook({ description })}
            />
            <Field
              label={t("Scan depth")}
              value={book.scanDepth}
              numeric
              disabled={inactive}
              error={errors["lorebook.scanDepth"]}
              onChange={(scanDepth) => updateBook({ scanDepth })}
            />
            <Field
              label={t("Token budget")}
              value={book.tokenBudget}
              numeric
              disabled={inactive}
              error={errors["lorebook.tokenBudget"]}
              onChange={(tokenBudget) => updateBook({ tokenBudget })}
            />
            {book.entries.map((entry, index) => {
              const path = `lorebook.entries.${index}`;
              return (
                <Disclosure
                  key={index}
                  forceOpen={showErrors}
                  title={entry.keys[0] || t("Entry {number}", { number: index + 1 })}
                >
                  <Keys
                    label={t("Primary keys")}
                    values={entry.keys}
                    disabled={inactive}
                    errors={errors}
                    path={`${path}.keys`}
                    onChange={(keys) => updateEntry(index, { keys })}
                  />
                  <Keys
                    label={t("Secondary keys")}
                    values={entry.secondaryKeys}
                    disabled={inactive}
                    errors={errors}
                    path={`${path}.secondaryKeys`}
                    onChange={(secondaryKeys) => updateEntry(index, { secondaryKeys })}
                  />
                  <Field
                    label={t("Entry content")}
                    value={entry.content}
                    multiline
                    disabled={inactive}
                    error={errors[`${path}.content`]}
                    onChange={(content) => updateEntry(index, { content })}
                  />
                  {(
                    [
                      ["enabled", t("Enabled")],
                      ["constant", t("Always active")],
                      ["selective", t("Require secondary match")],
                      ["caseSensitive", t("Case sensitive")],
                    ] as const
                  ).map(([key, label]) => (
                    <View key={key} style={styles.switchRow}>
                      <Text style={{ color: tokens.foreground, flex: 1 }}>{label}</Text>
                      <NativeSwitch
                        accessibilityLabel={label}
                        value={entry[key]}
                        disabled={inactive}
                        onValueChange={(value) => updateEntry(index, { [key]: value })}
                      />
                    </View>
                  ))}
                  <Field
                    label={t("Insertion order")}
                    value={entry.insertionOrder}
                    numeric
                    disabled={inactive}
                    error={errors[`${path}.insertionOrder`]}
                    onChange={(insertionOrder) => updateEntry(index, { insertionOrder })}
                  />
                  <MenuPicker
                    label={t("Position")}
                    value={entry.position}
                    choices={[
                      { key: "before_char", label: t("Before character"), disabled: inactive },
                      { key: "after_char", label: t("After character"), disabled: inactive },
                    ]}
                    onChange={(position) => {
                      if (!inactive && (position === "before_char" || position === "after_char"))
                        updateEntry(index, { position });
                    }}
                  />
                  <NativeActionButton
                    label={t("Remove entry")}
                    disabled={inactive}
                    prominence="destructive"
                    onPress={() =>
                      updateBook({
                        entries: book.entries.filter((_, current) => current !== index),
                      })
                    }
                  />
                </Disclosure>
              );
            })}
            {errors["lorebook.entries"] ? (
              <FieldError>{errors["lorebook.entries"]}</FieldError>
            ) : null}
            <NativeActionButton
              label={t("Add entry")}
              disabled={inactive || book.entries.length >= 500}
              prominence="secondary"
              onPress={() =>
                updateBook({
                  entries: [
                    ...book.entries,
                    { ...createRoleplayLorebookEntry(), insertionOrder: "0" },
                  ],
                })
              }
            />
            <NativeActionButton
              label={t("Remove lorebook")}
              disabled={inactive}
              prominence="destructive"
              onPress={() => update({ lorebook: null })}
            />
          </>
        ) : (
          <NativeActionButton
            label={t("Add lorebook")}
            disabled={inactive}
            prominence="secondary"
            onPress={() =>
              update({
                lorebook: draftFrom({ ...baseline, lorebook: createRoleplayLorebook() }).lorebook,
              })
            }
          />
        )}
      </Disclosure>
      {dirty ? (
        <>
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
            {t(
              "Changes apply next turn and keep history and memory. The first message applies after a conversation reset.",
            )}
          </Text>
          {errors[""] ? <FieldError>{errors[""]}</FieldError> : null}
          {failure ? <FieldError>{failure}</FieldError> : null}
          <NativeActionButton
            label={pending ? t("Saving…") : t("Save changes")}
            disabled={inactive}
            busy={pending}
            onPress={() => void save()}
          />
          <NativeActionButton
            label={t("Discard")}
            disabled={inactive}
            prominence="secondary"
            onPress={discard}
          />
        </>
      ) : null}
    </View>
  );
}

function Disclosure({
  title,
  children,
  initiallyOpen = false,
  forceOpen = false,
}: {
  title: string;
  children: ReactNode;
  initiallyOpen?: boolean;
  forceOpen?: boolean;
}) {
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.disclosure}
      >
        <Text numberOfLines={1} style={{ color: tokens.foreground, flex: 1, fontWeight: "600" }}>
          {title}
        </Text>
        <Chevron expanded={open} />
      </Pressable>
      {open ? <View style={styles.fields}>{children}</View> : null}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  disabled,
  numeric = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  numeric?: boolean;
  multiline?: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        keyboardType={numeric ? "numbers-and-punctuation" : "default"}
        multiline={multiline}
        scrollEnabled={false}
        textAlignVertical="top"
        style={[
          styles.input,
          {
            color: tokens.foreground,
            backgroundColor: native.fill,
            borderColor: error ? tokens.destructive : tokens.border,
            minHeight: multiline ? 88 : 44,
          },
        ]}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </View>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  const tokens = useMobileTokens();
  return (
    <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
      {children}
    </Text>
  );
}

function Keys({
  label,
  values,
  onChange,
  disabled,
  errors,
  path,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  disabled: boolean;
  errors: Record<string, string>;
  path: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{label}</Text>
      {values.map((value, index) => (
        <View key={index} style={{ gap: 4 }}>
          <Field
            label={t("{label} {number}", { label, number: index + 1 })}
            value={value}
            disabled={disabled}
            error={errors[`${path}.${index}`]}
            onChange={(next) =>
              onChange(values.map((key, current) => (current === index ? next : key)))
            }
          />
          <NativeActionButton
            label={t("Remove key")}
            disabled={disabled}
            prominence="quiet"
            accessibilityLabel={t("Remove {label} {number}", { label, number: index + 1 })}
            onPress={() => onChange(values.filter((_, current) => current !== index))}
          />
        </View>
      ))}
      {errors[path] ? <FieldError>{errors[path]}</FieldError> : null}
      <NativeActionButton
        label={t("Add key")}
        accessibilityLabel={t("Add {label}", { label })}
        disabled={disabled || values.length >= 100}
        prominence="secondary"
        onPress={() => onChange([...values, ""])}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { marginTop: 24, gap: 12 },
  fields: { gap: 16, paddingBottom: 12 },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  input: { padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
});
