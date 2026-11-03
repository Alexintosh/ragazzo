import type { RoleplayCharacter } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { pickFromLibrary } from "../lib/pick-attachments";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
import { ReplyThumbnail } from "./reply-thumbnail";

type Media = NonNullable<RoleplayCharacter["media"]>;
export function RoleplayImages({
  botId,
  value,
  disabled,
  onChange,
  errors = {},
  onPendingChange,
}: {
  onPendingChange?: (pending: boolean) => void;
  errors?: Record<string, string>;
  botId: string;
  value: RoleplayCharacter["media"];
  disabled: boolean;
  onChange: (value: Media) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const media: Media = value ?? {
    enabled: false,
    allowSpontaneous: false,
    normalIntervalTurns: 6,
    storyIntervalTurns: 2,
    album: [],
  };
  const current = useRef(media);
  current.current = media;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showFrequency, setShowFrequency] = useState(false);
  const [mimeTypes, setMimeTypes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!media.enabled) return;
    let cancelled = false;
    void rpc("bots/roleplayMedia", { botId })
      .then((state) => {
        if (!cancelled)
          setMimeTypes(
            Object.fromEntries(state.artifacts.map((artifact) => [artifact.id, artifact.mimeType])),
          );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, media.enabled]);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const adding = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  function update(patch: Partial<Media>) {
    onChange({ ...current.current, ...patch });
  }
  async function add(fromUrl: boolean) {
    if (adding.current || disabled || current.current.album.length >= 32) return;
    adding.current = true;
    onPendingChange?.(true);
    setPending(true);
    setFailure(null);
    try {
      const attachments = fromUrl
        ? []
        : (await pickFromLibrary(0, undefined, 32 - current.current.album.length)).attachments;
      const artifacts = fromUrl ? [await rpc("bots/importRoleplayMedia", { botId, url })] : [];
      for (const file of attachments)
        artifacts.push(
          await rpc("artifacts/create", {
            botId,
            name: file.name,
            mimeType: file.mimeType,
            contentBase64: file.contentBase64,
          }),
        );
      const album = [...current.current.album];
      for (const artifact of artifacts)
        if (!album.some((entry) => entry.artifactId === artifact.id))
          album.push({
            id: artifact.id,
            artifactId: artifact.id,
            description: artifact.name,
            enabled: true,
          });
      setMimeTypes((previous) => ({
        ...previous,
        ...Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact.mimeType])),
      }));
      update({ album });
      setUrl("");
    } catch (error) {
      setFailure(errorText(error, t("Could not add image")));
    } finally {
      adding.current = false;
      onPendingChange?.(false);
      setPending(false);
    }
  }
  const inactive = disabled || pending;
  function field(label: string, text: string, change: (value: string) => void, numeric = false) {
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={text}
          onChangeText={change}
          editable={!inactive}
          keyboardType={numeric ? "numbers-and-punctuation" : "default"}
          style={{
            color: tokens.foreground,
            backgroundColor: native.fill,
            padding: 12,
            borderRadius: 10,
            minHeight: 44,
          }}
        />
      </View>
    );
  }
  function toggle(label: string, checked: boolean, change: (value: boolean) => void) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ color: tokens.foreground, flex: 1 }}>{label}</Text>
        <NativeSwitch
          accessibilityLabel={label}
          value={checked}
          disabled={inactive}
          onValueChange={change}
        />
      </View>
    );
  }
  return (
    <View style={{ gap: 16 }}>
      {toggle(t("Images"), media.enabled, (enabled) => update({ enabled }))}
      {media.enabled ? (
        <>
          {media.album.map((entry) => (
            <View
              key={entry.id}
              style={{
                gap: 12,
                borderBottomWidth: 1,
                borderColor: tokens.border,
                paddingBottom: 12,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={entry.description || t("Image")}
                accessibilityState={{ expanded: expanded === entry.id }}
                onPress={() => setExpanded(expanded === entry.id ? null : entry.id)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}
              >
                {mimeTypes[entry.artifactId] ? (
                  <ReplyThumbnail
                    threadTarget={{ botId }}
                    attachment={{
                      kind: "image",
                      name: entry.description,
                      artifactId: entry.artifactId,
                      mimeType: mimeTypes[entry.artifactId]!,
                    }}
                  />
                ) : null}
                <Text numberOfLines={1} style={{ color: tokens.foreground, flex: 1 }}>
                  {entry.description || t("Image")}
                </Text>
              </Pressable>
              {expanded === entry.id ? (
                <>
                  {field(t("Description"), entry.description, (description) =>
                    update({
                      album: media.album.map((image) =>
                        image.id === entry.id ? { ...image, description } : image,
                      ),
                    }),
                  )}
                  {field(t("Scene"), entry.scene ?? "", (scene) =>
                    update({
                      album: media.album.map((image) =>
                        image.id === entry.id ? { ...image, scene: scene || undefined } : image,
                      ),
                    }),
                  )}
                  {toggle(t("Enabled"), entry.enabled, (enabled) =>
                    update({
                      album: media.album.map((image) =>
                        image.id === entry.id ? { ...image, enabled } : image,
                      ),
                    }),
                  )}
                  <NativeActionButton
                    label={t("Remove image")}
                    prominence="destructive"
                    disabled={inactive}
                    onPress={() =>
                      update({ album: media.album.filter((image) => image.id !== entry.id) })
                    }
                  />
                </>
              ) : null}
            </View>
          ))}
          <NativeActionButton
            label={t("Upload image")}
            disabled={inactive || media.album.length >= 32}
            busy={pending}
            onPress={() => void add(false)}
          />
          <NativeActionButton
            label={t("Import from URL")}
            prominence="quiet"
            onPress={() => setShowImport(!showImport)}
          />
          {showImport ? (
            <>
              {field(t("Image URL"), url, setUrl)}
              <NativeActionButton
                label={t("Import from URL")}
                prominence="secondary"
                disabled={inactive || !url.trim() || media.album.length >= 32}
                onPress={() => void add(true)}
              />
            </>
          ) : null}
          <NativeActionButton
            label={t("Frequency")}
            prominence="quiet"
            onPress={() => setShowFrequency(!showFrequency)}
          />
          {showFrequency ? (
            <>
              {toggle(t("Spontaneous images"), media.allowSpontaneous, (allowSpontaneous) =>
                update({ allowSpontaneous }),
              )}
              {field(
                t("Normal chat: turns between images"),
                Number.isNaN(media.normalIntervalTurns) ? "" : String(media.normalIntervalTurns),
                (value) =>
                  update({ normalIntervalTurns: value.trim() ? Number(value) : Number.NaN }),
                true,
              )}
              {field(
                t("Story mode: turns between images"),
                Number.isNaN(media.storyIntervalTurns) ? "" : String(media.storyIntervalTurns),
                (value) =>
                  update({ storyIntervalTurns: value.trim() ? Number(value) : Number.NaN }),
                true,
              )}
            </>
          ) : null}
        </>
      ) : null}
      {Object.entries(errors)
        .filter(([path]) => path.startsWith("media"))
        .map(([path, message]) => (
          <Text key={path} accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {message}
          </Text>
        ))}
      {failure ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {failure}
        </Text>
      ) : null}
    </View>
  );
}
