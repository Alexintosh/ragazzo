import type { AgentActivityEntry } from "@rakazo/contracts";
import { formatCompactDuration } from "@rakazo/core";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function AgentActivity({
  entries,
  botName,
  defaultOpen = false,
}: {
  entries: readonly AgentActivityEntry[];
  botName?: (id: string) => string | undefined;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  if (!entries.length && !defaultOpen) return null;
  const statuses = {
    running: t("Running"),
    completed: t("Completed"),
    error: t("Failed"),
    paused: t("Waiting"),
    stopped: t("Stopped"),
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: tokens.border, paddingVertical: 4 }}>
      <NativeActionButton
        label={t("Agent activity")}
        prominence="plain"
        selected={open}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
          {!entries.length ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
              {t("No activity yet.")}
            </Text>
          ) : null}
          {entries.map((entry) => (
            <View key={entry.id} style={{ paddingVertical: 6, gap: 3 }}>
              <Text
                style={{
                  color: entry.status === "error" ? tokens.destructive : tokens.foreground,
                  fontSize: 13,
                }}
              >
                {entry.botId && botName?.(entry.botId) ? `${botName(entry.botId)} · ` : ""}
                {entry.kind === "thinking"
                  ? t("Thinking")
                  : entry.kind === "reasoning"
                    ? t("Reasoning summary")
                    : entry.label}
                {` · ${statuses[entry.status]}`}
                {entry.durationMs !== undefined
                  ? ` · ${formatCompactDuration(entry.durationMs)}`
                  : ""}
              </Text>
              {entry.text ? (
                <Text selectable style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {entry.text}
                </Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
