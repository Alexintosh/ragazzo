import type { CalendarView } from "@rakazo/core";
import { calendarEntries, calendarHistory, calendarRange, shiftCalendar } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { activityStatusLabel } from "../lib/activity";
import { createConversationRequest } from "../lib/conversation-work";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineCalendar() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const [request] = useState(createConversationRequest);
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const { t, locale } = useI18n();
  const router = useRouter();
  const [date, setDate] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const { from, to } = calendarRange(date, view);
  const routines = useQuery(
    { ...rpcQuery("routines/list", { botId: botId! }), enabled: Boolean(botId) },
    queryClient,
  );
  const scope = rpcQuery("routines/list", { botId: botId! });
  const history = useQuery(
    {
      queryKey: [
        ...scope.queryKey,
        "calendar",
        from.toISOString(),
        to.toISOString(),
        routines.data?.map((routine) => routine.id),
      ],
      enabled: Boolean(routines.data),
      queryFn: async ({ signal }) => {
        const runLists = await Promise.all(
          (routines.data ?? []).map((routine) =>
            calendarHistory(
              routine.id,
              from,
              to,
              (input) => request("routines/history", input, { signal }),
              signal,
            ),
          ),
        );
        const results = (routines.data ?? []).map((routine, index) =>
          calendarEntries(routine, runLists[index] ?? [], { from, to }, new Date()),
        );
        return {
          entries: results
            .flatMap((result) => result.entries)
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
          truncated: results.some((result) => result.truncated),
        };
      },
    },
    queryClient,
  );
  const days = new Map<string, NonNullable<typeof history.data>["entries"]>();
  for (const entry of history.data?.entries ?? []) {
    const day = new Date(entry.at).toLocaleDateString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 20, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(t("Routine calendar"))} />
      <MenuPicker
        label={t("View")}
        choices={[
          { key: "day", label: t("Day") },
          { key: "week", label: t("Week") },
          { key: "month", label: t("Month") },
        ]}
        value={view}
        onChange={(value) => setView(value as CalendarView)}
      />
      <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 20 }}>
        {from.toLocaleDateString(locale)} – {new Date(to.getTime() - 1).toLocaleDateString(locale)}
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap" }}>
        <NativeActionButton
          label={t("Previous")}
          prominence="plain"
          onPress={() => setDate(shiftCalendar(date, view, -1))}
        />
        <NativeActionButton
          label={t("Today")}
          prominence="plain"
          onPress={() => setDate(new Date())}
        />
        <NativeActionButton
          label={t("Next")}
          prominence="plain"
          onPress={() => setDate(shiftCalendar(date, view, 1))}
        />
      </View>
      {routines.isLoading || history.isLoading ? <ActivityIndicator /> : null}
      {routines.error || history.error ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {errorText(routines.error ?? history.error)}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            onPress={() => {
              void routines.refetch();
              void history.refetch();
            }}
          />
        </>
      ) : null}
      {[...days].map(([day, entries]) => (
        <SettingsGroup key={day} label={day}>
          {entries.map((entry) => (
            <SettingsRow
              key={entry.id}
              title={entry.routine.name}
              detail={`${new Date(entry.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} · ${entry.run ? activityStatusLabel(entry.run.status) : t("Scheduled")}`}
              chevron="right"
              onPress={() => {
                if (entry.run?.messageId)
                  router.push({
                    pathname: "/thread",
                    params: {
                      ...(entry.run.groupId
                        ? { groupId: entry.run.groupId }
                        : { botId: entry.routine.botId }),
                      messageId: entry.run.messageId,
                    },
                  });
                else
                  router.push({
                    pathname: "/routine",
                    params: { botId: entry.routine.botId, routineId: entry.routine.id },
                  });
              }}
            />
          ))}
        </SettingsGroup>
      ))}
      {history.data && !history.data.entries.length ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No scheduled work")}</Text>
      ) : null}
      {history.data?.truncated ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Showing the first 1,000 occurrences. Choose a shorter range.")}
        </Text>
      ) : null}
    </ScrollView>
  );
}
