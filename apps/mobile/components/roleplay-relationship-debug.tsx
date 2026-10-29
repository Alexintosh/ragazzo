import type { RoleplayRelationshipDebug as RoleplayRelationshipState } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { Chevron } from "./row-accessories";

type Scores = Record<keyof RoleplayRelationshipState["relationship"], string>;
const draftFrom = (state: RoleplayRelationshipState): Scores => ({
  warmth: String(state.relationship.warmth),
  intimacy: String(state.relationship.intimacy),
  love: String(state.relationship.love),
});

export function RoleplayRelationshipDebug({
  onLoad,
  onSave,
}: {
  onLoad: () => Promise<RoleplayRelationshipState>;
  onSave: (state: RoleplayRelationshipState) => Promise<RoleplayRelationshipState>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<RoleplayRelationshipState | null>(null);
  const [draft, setDraft] = useState<Scores | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  const loadError = useRef("");
  loadError.current = t("Could not load relationship");
  const saving = useRef(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPending(true);
    setFailure(null);
    setSaved(null);
    setDraft(null);
    void load
      .current()
      .then((state) => {
        if (!cancelled) {
          setSaved(state);
          setDraft(draftFrom(state));
        }
      })
      .catch((error) => {
        if (!cancelled) setFailure(errorText(error, loadError.current));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const dirty = saved && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));
  async function save() {
    if (!saved || !draft || pending || saving.current) return;
    const values = Object.values(draft);
    if (values.some((value) => !/^\d+$/.test(value) || Number(value) > 100)) {
      setFailure(t("Enter whole numbers from 0 to 100."));
      return;
    }
    saving.current = true;
    setPending(true);
    setFailure(null);
    try {
      const state = await onSave({
        ...saved,
        relationship: {
          warmth: Number(draft.warmth),
          intimacy: Number(draft.intimacy),
          love: Number(draft.love),
        },
      });
      setSaved(state);
      setDraft(draftFrom(state));
    } catch (error) {
      setFailure(errorText(error, t("Could not save relationship")));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <View style={{ marginTop: 24, gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Relationship debug")}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          if (!pending) setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 44, gap: 12 }}
      >
        <Text style={{ color: tokens.foreground, flex: 1, fontWeight: "600" }}>
          {t("Relationship debug")}
        </Text>
        <Chevron expanded={open} />
      </Pressable>
      {open ? (
        <View style={{ gap: 12 }}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
            {t("Changes affect this conversation.")}
          </Text>
          {pending && !draft ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Loading…")}</Text>
          ) : null}
          {draft ? (
            <>
              {(
                [
                  ["warmth", t("Warmth")],
                  ["intimacy", t("Intimacy")],
                  ["love", t("Love")],
                ] as const
              ).map(([key, label]) => (
                <View key={key} style={{ gap: 6 }}>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{label}</Text>
                  <TextInput
                    accessibilityLabel={label}
                    keyboardType="number-pad"
                    editable={!pending}
                    value={draft[key]}
                    onChangeText={(value) => setDraft({ ...draft, [key]: value })}
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: tokens.border,
                      color: tokens.foreground,
                      backgroundColor: native.fill,
                      fontSize: 16,
                    }}
                  />
                </View>
              ))}
              {dirty ? (
                <>
                  <NativeActionButton
                    label={pending ? t("Saving…") : t("Save changes")}
                    disabled={pending}
                    busy={pending}
                    onPress={() => void save()}
                  />
                  <NativeActionButton
                    label={t("Discard")}
                    disabled={pending}
                    prominence="secondary"
                    onPress={() => {
                      setDraft(draftFrom(saved!));
                      setFailure(null);
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {failure ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 13 }}>
              {failure}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
