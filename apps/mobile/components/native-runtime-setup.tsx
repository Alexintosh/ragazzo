import type { NativeSetupInput, NativeSetupKind, NativeSetupView } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { ApiRequestContext } from "../lib/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { currentSessionGeneration } from "../lib/session";
import { NativeActionButton } from "./native-action-button";

export function NativeRuntimeSetup(props: {
  spaceId: string;
  kind: NativeSetupKind;
  hostId: string | null;
}) {
  return <SetupPanel key={`${props.spaceId}:${props.kind}:${props.hostId}`} {...props} />;
}
function SetupPanel({
  spaceId,
  kind,
  hostId,
}: {
  spaceId: string;
  kind: NativeSetupKind;
  hostId: string | null;
}) {
  const { t } = useI18n();
  const colors = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NativeSetupView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0),
    sequence = useRef(0),
    changing = useRef(false);
  function current(context: ApiRequestContext, epoch: number) {
    return (
      generation.current === epoch &&
      context.apiBase === currentApiBase() &&
      context.sessionGeneration === currentSessionGeneration() &&
      selectedSpaceId() === spaceId
    );
  }
  useEffect(() => {
    const epoch = ++generation.current;
    changing.current = false;
    setBusy(false);
    if (!open) return;
    let fetching = false;
    const refresh = async () => {
      if (fetching || changing.current) return;
      fetching = true;
      const request = ++sequence.current;
      try {
        const requestContext = await captureApiRequestContext(spaceId);
        if (!current(requestContext, epoch)) return;
        const next = await rpc(
          "nativeSetup/request",
          { kind, hostId, action: "status" },
          { requestContext },
        );
        if (current(requestContext, epoch) && sequence.current === request) {
          setView(next);
          setError(false);
        }
      } catch {
        if (generation.current === epoch && sequence.current === request) {
          setView(undefined);
          setError(true);
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [open, kind, hostId, spaceId]);
  async function act(action: NativeSetupInput["action"]) {
    const epoch = generation.current,
      request = ++sequence.current;
    changing.current = true;
    setBusy(true);
    setError(false);
    const sessionId = view?.session?.id;
    if (action === "cancel") setView(undefined);
    try {
      const requestContext = await captureApiRequestContext(spaceId);
      if (!current(requestContext, epoch)) return;
      const next = await rpc(
        "nativeSetup/request",
        { kind, hostId, action, ...(action === "cancel" ? { sessionId } : {}) },
        { requestContext },
      );
      if (current(requestContext, epoch) && sequence.current === request) setView(next);
    } catch {
      if (generation.current === epoch) setError(true);
    } finally {
      if (generation.current === epoch) {
        changing.current = false;
        setBusy(false);
      }
    }
  }
  const session = view?.session;
  const active = session && ["awaiting-consent", "running"].includes(session.state);
  const states = {
    "awaiting-consent": t("Approve in the host terminal"),
    running: t("Setup running"),
    succeeded: t("Setup complete"),
    failed: t("Setup failed"),
    cancelled: t("Setup cancelled"),
    expired: t("Setup expired"),
  };
  return (
    <View style={{ gap: 8 }}>
      <NativeActionButton
        label={t("Set up runtime")}
        prominence="plain"
        onPress={() => {
          setView(undefined);
          setOpen(!open);
        }}
      />
      {open ? (
        <>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: colors.destructive }}>
              {t("Could not check runtime setup")}
            </Text>
          ) : null}
          {view ? (
            <>
              <Text style={{ color: colors.mutedForeground }}>
                {view.authenticated
                  ? t("Runtime ready")
                  : view.available
                    ? t("Sign-in required")
                    : t("CLI unavailable")}
              </Text>
              {kind === "acp" ? (
                <Text style={{ color: colors.mutedForeground }}>
                  {t("Configure the ACP command in the host’s private native-providers.json file.")}
                </Text>
              ) : null}
              {!active && !view.available && view.installSupported ? (
                <NativeActionButton
                  label={t("Prepare install")}
                  disabled={busy}
                  onPress={() => void act("install")}
                />
              ) : null}
              {!active && view.available && view.loginSupported ? (
                <NativeActionButton
                  label={t("Prepare sign-in")}
                  disabled={busy}
                  onPress={() => void act("login")}
                />
              ) : null}
            </>
          ) : null}
          {session ? (
            <>
              <Text style={{ color: colors.foreground }}>{states[session.state]}</Text>
              {session.state === "awaiting-consent" ? (
                <>
                  <Text selectable style={{ color: colors.mutedForeground }}>
                    {session.destination}
                  </Text>
                  <Text selectable style={{ color: colors.foreground }}>
                    {session.command.map((part) => JSON.stringify(part)).join(" ")}
                  </Text>
                  <Text selectable style={{ color: colors.foreground }}>
                    {session.localApproval}
                  </Text>
                </>
              ) : null}
              {session.verificationUrl ? (
                <NativeActionButton
                  label={t("Continue sign-in")}
                  onPress={() => void Linking.openURL(session.verificationUrl!)}
                />
              ) : null}
              {session.userCode ? (
                <Text selectable style={{ color: colors.foreground }}>
                  {t("Device code")}: {session.userCode}
                </Text>
              ) : null}
              {session.action === "login" && kind === "claude" && session.state === "running" ? (
                <Text style={{ color: colors.mutedForeground }}>
                  {t("Continue in the host browser.")}
                </Text>
              ) : null}
              {active ? (
                <NativeActionButton
                  label={t("Cancel setup")}
                  disabled={busy}
                  onPress={() => void act("cancel")}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
