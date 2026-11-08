import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useRoleplayStoryMode } from "../lib/use-roleplay-story-mode";
import { NativeActionButton } from "./native-action-button";

export function RoleplayStoryMode({ botId, refreshKey }: { botId: string; refreshKey?: unknown }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { state, pending, failure, toggle, retry } = useRoleplayStoryMode(botId, refreshKey);
  return (
    <View style={{ gap: 12 }}>
      <NativeActionButton
        label={state?.storyMode ? t("Leave story mode") : t("Story mode")}
        busy={pending}
        disabled={pending || !state}
        onPress={() => void toggle()}
        prominence="secondary"
      />
      {state?.storyMode && state.scene ? (
        <Text style={{ color: tokens.mutedForeground }}>{state.scene}</Text>
      ) : null}
      {failure ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {failure}
          </Text>
          <NativeActionButton label={t("Retry")} onPress={retry} prominence="quiet" />
        </>
      ) : null}
    </View>
  );
}
