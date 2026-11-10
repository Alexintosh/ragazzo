import type { RegisteredHost } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { ApiRequestContext } from "../lib/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { currentSessionGeneration } from "../lib/session";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function RegisteredHostPicker({
  spaceId,
  value,
  localHostConfigured = false,
  onChange,
}: {
  spaceId: string;
  value: string | null;
  localHostConfigured?: boolean;
  onChange: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const colors = useMobileTokens();
  const [hosts, setHosts] = useState<RegisteredHost[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const intent = useRef(0);
  function scopeCurrent(context: ApiRequestContext) {
    return (
      context.apiBase === currentApiBase() &&
      context.sessionGeneration === currentSessionGeneration() &&
      selectedSpaceId() === spaceId
    );
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setHosts([]);
    setOpen(false);
    setToken("");
    setBusy(false);
    void captureApiRequestContext(spaceId)
      .then(async (requestContext) => {
        const rows = await rpc("hosts/list", {}, { requestContext });
        if (generation.current === epoch && scopeCurrent(requestContext)) setHosts(rows);
      })
      .catch(() => {
        if (generation.current === epoch) setError(t("Could not load hosts"));
      });
    return () => {
      generation.current++;
    };
  }, [spaceId]);
  async function perform(
    action: (context: ApiRequestContext, current: () => boolean) => Promise<void>,
  ) {
    const epoch = generation.current;
    const input = intent.current;
    setBusy(true);
    setError("");
    try {
      const context = await captureApiRequestContext(spaceId);
      const current = () =>
        generation.current === epoch && intent.current === input && scopeCurrent(context);
      if (current()) await action(context, current);
    } catch {
      if (generation.current === epoch && intent.current === input)
        setError(t("Could not update host"));
    } finally {
      if (generation.current === epoch) setBusy(false);
    }
  }
  const selected = hosts.find((host) => host.id === value);
  const choices = hosts
    .filter((host) => !host.revokedAt)
    .map((host) => ({ key: host.id, label: host.name }));
  return (
    <View style={{ gap: 8 }}>
      <MenuPicker
        plain
        label={t("Host")}
        value={value ?? ""}
        choices={[
          {
            key: "",
            label: localHostConfigured ? t("Local bridge") : t("Choose a host"),
            disabled: !localHostConfigured,
          },
          ...choices,
          ...(value && !choices.some((host) => host.key === value)
            ? [{ key: value, label: t("Unavailable host"), disabled: true }]
            : []),
        ]}
        onChange={(next) => {
          if (!next && !localHostConfigured) return;
          intent.current++;
          onChange(next || null);
        }}
      />
      {selected ? (
        <>
          <Text style={{ color: colors.mutedForeground }}>
            {selected.endpoint} · {selected.healthStatus}
          </Text>
          {selected.revocationPending ? (
            <Text style={{ color: colors.mutedForeground }}>{t("Stopping work")}</Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <NativeActionButton
              label={t("Check")}
              prominence="plain"
              disabled={busy}
              onPress={() =>
                void perform(async (requestContext, current) => {
                  const next = await rpc(
                    "hosts/check",
                    { hostId: selected.id },
                    { requestContext },
                  );
                  if (current())
                    setHosts((rows) => rows.map((row) => (row.id === next.id ? next : row)));
                })
              }
            />
            <NativeActionButton
              label={t("Revoke")}
              prominence="destructive"
              disabled={busy || (!!selected.revokedAt && !selected.revocationPending)}
              onPress={() =>
                void perform(async (requestContext, current) => {
                  const next = await rpc(
                    "hosts/revoke",
                    { hostId: selected.id },
                    { requestContext },
                  );
                  if (current())
                    setHosts((rows) => rows.map((row) => (row.id === next.id ? next : row)));
                })
              }
            />
          </View>
        </>
      ) : null}
      <NativeActionButton
        label={t("Register host")}
        prominence="plain"
        onPress={() => {
          intent.current++;
          setToken("");
          setOpen(!open);
        }}
      />
      {open ? (
        <View style={{ gap: 8 }}>
          <TextInput
            accessibilityLabel={t("Host name")}
            placeholder={t("Host name")}
            value={name}
            onChangeText={(text) => {
              intent.current++;
              setName(text);
            }}
            style={{ color: colors.foreground, minHeight: 44 }}
          />
          <TextInput
            accessibilityLabel={t("Host URL")}
            placeholder="https://host.example.test"
            autoCapitalize="none"
            autoCorrect={false}
            value={endpoint}
            onChangeText={(text) => {
              intent.current++;
              setEndpoint(text);
            }}
            style={{ color: colors.foreground, minHeight: 44 }}
          />
          <TextInput
            accessibilityLabel={t("Host token")}
            placeholder={t("Host token")}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={(text) => {
              intent.current++;
              setToken(text);
            }}
            style={{ color: colors.foreground, minHeight: 44 }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: colors.foreground }}>
              {t("I trust this host to run commands and access project files.")}
            </Text>
            <NativeSwitch
              accessibilityLabel={t("I trust this host to run commands and access project files.")}
              value={trusted}
              onValueChange={(next) => {
                intent.current++;
                setTrusted(next);
              }}
            />
          </View>
          <NativeActionButton
            label={t("Register")}
            disabled={busy || !trusted || !name.trim() || !endpoint.trim() || !token.trim()}
            onPress={() =>
              void perform(async (requestContext, current) => {
                const next = await rpc(
                  "hosts/register",
                  { name, endpoint, token, trusted: true },
                  { requestContext },
                );
                if (!current()) return;
                setHosts((rows) => [...rows, next]);
                setToken("");
                setOpen(false);
                onChange(next.id);
              })
            }
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
