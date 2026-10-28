import type { ComputerMode, CreateBotInput } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  NativeRuntimeCapabilities,
} from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Stack, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { NativeRuntimeSetup } from "../components/native-runtime-setup";
import { RegisteredHostPicker } from "../components/registered-host-picker";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { selectedSpaceId } from "../lib/api";
import { createConversationRequest } from "../lib/conversation-work";
import { createInboxBot } from "../lib/create-inbox-bot";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { queryClient } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { useSandboxProvider } from "../lib/use-sandbox-provider";
import { errorText } from "../lib/user-error";

export default function NewBot() {
  const [request] = useState(createConversationRequest);
  const [originSpaceId] = useState(selectedSpaceId);
  const [registeredHostId, setRegisteredHostId] = useState<string | null>(null);
  const { t } = useI18n();
  const environment = useSandboxProvider();
  const dockerHint = environment.failed
    ? t("Could not check Docker availability.")
    : environment.loading
      ? t("Checking Docker availability…")
      : t("Docker is not enabled on this deployment.");
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const router = useRouter();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [runtimeKind, setRuntimeKind] = useState<NonNullable<CreateBotInput["runtimeKind"]>>("pi");
  const [executionTarget, setExecutionTarget] =
    useState<NonNullable<CreateBotInput["executionTarget"]>>("default");
  const [runtimePermission, setRuntimePermission] =
    useState<NonNullable<CreateBotInput["runtimePermission"]>>("workspace");
  const [projectPath, setProjectPath] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [spawnKey] = useState(newClientId);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await createInboxBot({
        input: {
          spawnKey,
          name: name.trim() || t("New Bot"),
          title,
          description,
          computerMode,
          runtimeKind,
          executionTarget,
          registeredHostId: executionTarget === "host" ? registeredHostId : null,
          runtimePermission,
          projectPath: projectPath.trim() || null,
        },
        request,
        refreshBots: () => queryClient.invalidateQueries(),
        openChat: (href) => router.replace(href),
      });
    } catch (cause) {
      setError(errorText(cause, t("Could not create bot")));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const fieldStyle = {
    color: tokens.foreground,
    backgroundColor: native.fill,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
  };
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 20, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ ...glassHeaderOptions(t("New bot")), gestureEnabled: !busy }} />
      <TextInput
        accessibilityLabel={t("Name")}
        placeholder={t("Name")}
        placeholderTextColor={tokens.mutedForeground}
        value={name}
        onChangeText={setName}
        maxLength={BOT_NAME_MAX_LENGTH}
        editable={!busy}
        style={fieldStyle}
      />
      <TextInput
        accessibilityLabel={t("Title")}
        placeholder={t("Title")}
        placeholderTextColor={tokens.mutedForeground}
        value={title}
        onChangeText={setTitle}
        maxLength={BOT_TITLE_MAX_LENGTH}
        editable={!busy}
        style={fieldStyle}
      />
      <TextInput
        accessibilityLabel={t("Brief")}
        placeholder={t("Brief")}
        placeholderTextColor={tokens.mutedForeground}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={BOT_DESCRIPTION_MAX_LENGTH}
        editable={!busy}
        style={[fieldStyle, { minHeight: 110, textAlignVertical: "top" }]}
      />
      <SettingsGroup>
        <SettingsRow
          title={t("Runtime and computer")}
          chevron={advanced ? "down" : "right"}
          disabled={busy}
          onPress={() => setAdvanced(!advanced)}
        />
      </SettingsGroup>
      {advanced ? (
        <View style={{ gap: 18 }}>
          <SettingsGroup>
            <MenuPicker
              label={t("Runtime")}
              value={runtimeKind}
              choices={[
                { key: "pi", label: "Pi" },
                ...Object.entries(NativeRuntimeCapabilities).map(([key, capability]) => ({
                  key,
                  label: capability.label,
                })),
              ]}
              onChange={(value) => {
                if (busy) return;
                setRuntimeKind(value as typeof runtimeKind);
                if (value !== "pi") {
                  setExecutionTarget("host");
                  setComputerMode("dedicated");
                } else {
                  setRuntimePermission("workspace");
                  setProjectPath("");
                }
              }}
            />
            <MenuPicker
              label={t("Execution target")}
              value={executionTarget}
              choices={
                runtimeKind !== "pi"
                  ? [{ key: "host", label: t("Host") }]
                  : [
                      { key: "default", label: t("Deployment default") },
                      { key: "docker", label: "Docker", disabled: !environment.dockerAvailable },
                      { key: "host", label: t("Host") },
                    ]
              }
              onChange={(value) => {
                if (busy) return;
                if (value === "docker" && !environment.dockerAvailable) return;
                setExecutionTarget(value as typeof executionTarget);
                if (value !== "host") setRegisteredHostId(null);
                if (value !== executionTarget) setComputerMode("dedicated");
              }}
            />
            {runtimeKind === "pi" && !environment.dockerAvailable ? (
              <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{dockerHint}</Text>
            ) : null}
          </SettingsGroup>
          {executionTarget === "host" && originSpaceId ? (
            <RegisteredHostPicker
              spaceId={originSpaceId}
              value={registeredHostId}
              onChange={setRegisteredHostId}
            />
          ) : null}
          {runtimeKind !== "pi" && originSpaceId ? (
            <NativeRuntimeSetup
              spaceId={originSpaceId}
              kind={runtimeKind}
              hostId={registeredHostId}
            />
          ) : null}
          {runtimeKind !== "pi" ? (
            <>
              <TextInput
                accessibilityLabel={t("Project folder")}
                placeholder={t("Project folder")}
                placeholderTextColor={tokens.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                value={projectPath}
                onChangeText={setProjectPath}
                editable={!busy}
                style={fieldStyle}
              />
              <MenuPicker
                label={t("Permissions")}
                value={runtimePermission}
                choices={[
                  { key: "workspace", label: t("Workspace"), disabled: runtimeKind !== "codex" },
                  { key: "full", label: t("Full access") },
                ]}
                onChange={(value) => {
                  if (!busy) setRuntimePermission(value as typeof runtimePermission);
                }}
              />
            </>
          ) : null}
          <SettingsGroup label={t("Computer")}>
            <ComputerModePicker
              plain
              value={computerMode}
              onChange={setComputerMode}
              disabled={busy}
            />
          </SettingsGroup>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton label={t("Create bot")} busy={busy} onPress={() => void create()} />
    </ScrollView>
  );
}
