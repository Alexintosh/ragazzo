import { formatFileSize } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, ScrollView, Text } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function ConversationFiles() {
  const { botId, groupId, taskId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    taskId?: string;
  }>();
  const target = taskId ? { taskId } : groupId ? { groupId } : { botId: botId! };
  const files = useQuery(
    {
      ...rpcQuery("artifacts/listConversation", target),
      enabled: Boolean(botId || groupId || taskId),
    },
    queryClient,
  );
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const router = useRouter();
  useFocusEffect(
    useCallback(() => {
      void files.refetch();
    }, [botId, groupId, taskId]),
  );
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 20, gap: 20 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(t("Conversation files"))} />
      {files.isLoading ? <ActivityIndicator /> : null}
      {files.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {errorText(files.error)}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Refresh")}
        prominence="plain"
        onPress={() => void files.refetch()}
      />
      {files.data ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>
            {t("{files} files · {versions} versions · {size}", {
              files: files.data.storage.files,
              versions: files.data.storage.versions,
              size: formatFileSize(files.data.storage.bytes),
            })}
          </Text>
          <SettingsGroup>
            {files.data.items.map((file) => (
              <SettingsRow
                key={file.id}
                title={file.name}
                detail={`${file.origin === "attachment" ? t("Attachment") : file.origin === "generated" ? t("Generated") : t("File")} · ${formatFileSize(file.size)} · ${t("{count} versions", { count: file.versionCount })}`}
                chevron="right"
                onPress={() =>
                  router.push({
                    pathname: "/artifact",
                    params: { artifactId: file.familyId, ...(taskId ? { taskId } : {}) },
                  })
                }
              />
            ))}
            {!files.data.items.length ? <SettingsRow title={t("No files")} /> : null}
          </SettingsGroup>
        </>
      ) : null}
    </ScrollView>
  );
}
