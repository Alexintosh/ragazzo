import type { ConversationTask, ThreadQueue } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { activityStatusLabel } from "../lib/activity";
import { useAppForeground } from "../lib/app-foreground";
import { createConversationRequest, latestQueue, moveQueued } from "../lib/conversation-work";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function ConversationWork() {
  const { botId, groupId, taskId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    taskId?: string;
  }>();
  const key = taskId ? `task:${taskId}` : groupId ? `group:${groupId}` : `bot:${botId}`;
  return <Work key={key} botId={botId} groupId={groupId} taskId={taskId} />;
}

function Work({ botId, groupId, taskId }: { botId?: string; groupId?: string; taskId?: string }) {
  const [request] = useState(createConversationRequest);
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState("");
  const [showWriteScope, setShowWriteScope] = useState(false);
  const [writeSubdirectory, setWriteSubdirectory] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const nonces = useRef(new Map<string, string>());
  const [moreTasks, setMoreTasks] = useState<ConversationTask[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const target = taskId ? { taskId } : groupId ? { groupId } : { botId: botId! };
  const valid = Boolean(taskId || groupId || botId);
  const poll = focused && foreground ? 5_000 : false;
  const group = useQuery(
    { ...rpcQuery("groups/get", { groupId: groupId! }), enabled: Boolean(groupId) },
    queryClient,
  );
  const task = useQuery(
    { ...rpcQuery("tasks/get", { taskId: taskId! }), enabled: Boolean(taskId) },
    queryClient,
  );
  const recipientId = groupId ? recipient : taskId ? task.data?.botId : botId;
  const bots = useQuery(rpcQuery("bots/list"), queryClient);
  const scopeAvailable = bots.data?.some(
    (bot) =>
      bot.id === recipientId &&
      bot.runtimeKind === "codex" &&
      bot.runtimePermission === "workspace",
  );
  const queueTarget = { ...target, ...(groupId ? { recipientBotId: recipient } : {}) };
  const queueOptions = rpcQuery("threads/queue", queueTarget);
  const queueQuery = useQuery(
    {
      ...queueOptions,
      enabled: valid && Boolean(recipientId),
      refetchInterval: poll,
    },
    queryClient,
  );
  const tasks = useQuery(
    {
      ...rpcQuery("tasks/list", { ...(groupId ? { groupId } : { botId: recipientId }) }),
      enabled: valid && Boolean(groupId || recipientId),
      refetchInterval: poll,
    },
    queryClient,
  );
  const stopped = useQuery(
    { ...rpcQuery("tasks/stopped", target), enabled: valid, refetchInterval: poll },
    queryClient,
  );
  const queueRef = useRef<{ key: string; data: ThreadQueue | null }>({ key: "", data: null });
  const queueKey = JSON.stringify(queueOptions.queryKey);
  if (queueRef.current.key !== queueKey) queueRef.current = { key: queueKey, data: null };
  if (queueQuery.data) queueRef.current.data = latestQueue(queueRef.current.data, queueQuery.data);
  const queue = queueRef.current.data;
  const refresh = () =>
    Promise.all([
      ...(valid && recipientId ? [queueQuery.refetch()] : []),
      ...(valid && (groupId || recipientId) ? [tasks.refetch()] : []),
      ...(valid ? [stopped.refetch()] : []),
    ]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [queueKey]),
  );

  function nonce(key: string) {
    let value = nonces.current.get(key);
    if (!value) {
      value = newClientId();
      nonces.current.set(key, value);
    }
    return value;
  }
  function openTask(value: ConversationTask) {
    router.push({ pathname: "/task-conversation", params: { taskId: value.id } });
  }
  async function act(action: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await refresh();
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function queueAction(action: () => Promise<ThreadQueue>) {
    const requested = queueKey;
    await act(async () => {
      const next = await action();
      if (queueRef.current.key === requested) {
        queueRef.current.data = latestQueue(queueRef.current.data, next);
        queryClient.setQueryData(queueOptions.queryKey, queueRef.current.data);
      }
    });
  }
  const allTasks = [...(tasks.data?.tasks ?? []), ...moreTasks].filter(
    (value, index, values) => values.findIndex((item) => item.id === value.id) === index,
  );
  const readError =
    error ??
    (queueQuery.error || tasks.error || stopped.error || group.error || task.error
      ? errorText(queueQuery.error ?? tasks.error ?? stopped.error ?? group.error ?? task.error)
      : null);
  const disabled = busy || !recipientId;
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 20, gap: 20 }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={glassHeaderOptions(t("Conversation work"))} />
      <NativeActionButton
        label={t("Workflows")}
        prominence="plain"
        onPress={() => router.push("/workflows")}
      />
      {groupId ? (
        <MenuPicker
          label={t("Recipient")}
          choices={[
            { key: "", label: t("Choose a bot") },
            ...(group.data?.members ?? []).map((member) => ({
              key: member.botId,
              label: member.name,
            })),
          ]}
          value={recipient}
          onChange={(value) => {
            if (busyRef.current) return;
            setRecipient(value);
            setEditingId(null);
            setDraft("");
          }}
        />
      ) : null}
      {readError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {readError}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Refresh")}
        prominence="plain"
        onPress={() => void refresh()}
        disabled={busy}
      />
      {valid ? (
        <>
          <TextInput
            accessibilityLabel={editingId ? t("Edit queued message") : t("Task prompt")}
            placeholder={t("What needs doing?")}
            placeholderTextColor={tokens.mutedForeground}
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={20_000}
            editable={!busy}
            style={{
              color: tokens.foreground,
              backgroundColor: native.fill,
              borderRadius: 12,
              padding: 16,
              minHeight: 110,
              textAlignVertical: "top",
            }}
          />
          {editingId && queue ? (
            <>
              <NativeActionButton
                label={t("Save")}
                disabled={disabled || !draft.trim()}
                onPress={() =>
                  void queueAction(async () => {
                    const next = await request("threads/updateQueued", {
                      ...queueTarget,
                      id: editingId,
                      revision: queue.revision,
                      text: draft,
                    });
                    setDraft("");
                    setEditingId(null);
                    return next;
                  })
                }
              />
              <NativeActionButton
                label={t("Cancel")}
                prominence="plain"
                onPress={() => {
                  setEditingId(null);
                  setDraft("");
                }}
                disabled={busy}
              />
            </>
          ) : (
            <>
              {scopeAvailable ? (
                <>
                  <NativeActionButton
                    label={t("Write scope")}
                    prominence="plain"
                    onPress={() => setShowWriteScope(!showWriteScope)}
                    disabled={busy}
                  />
                  {showWriteScope ? (
                    <TextInput
                      accessibilityLabel={t("Project subdirectory")}
                      placeholder={t("Project subdirectory")}
                      value={writeSubdirectory}
                      onChangeText={setWriteSubdirectory}
                      editable={!busy}
                      autoCapitalize="none"
                      style={{
                        color: tokens.foreground,
                        backgroundColor: native.fill,
                        padding: 16,
                      }}
                    />
                  ) : null}
                </>
              ) : null}
              <NativeActionButton
                label={t("Start task")}
                disabled={disabled || !draft.trim()}
                onPress={() =>
                  void act(async () => {
                    const key = `task:${recipientId}:${draft}:${writeSubdirectory}`;
                    const input = {
                      botId: recipientId!,
                      text: draft,
                      clientNonce: nonce(key),
                      ...(groupId
                        ? { originGroupId: groupId }
                        : botId
                          ? { originBotId: botId }
                          : {}),
                    };
                    const created =
                      scopeAvailable && writeSubdirectory
                        ? await request("tasks/createScoped", { ...input, writeSubdirectory })
                        : await request("tasks/create", input);
                    nonces.current.delete(key);
                    setDraft("");
                    setWriteSubdirectory("");
                    openTask(created);
                  })
                }
              />
              <NativeActionButton
                label={t("Queue message")}
                prominence="secondary"
                disabled={disabled || !draft.trim() || !queue}
                onPress={() =>
                  void queueAction(async () => {
                    const key = `queue:${recipientId}:${draft}`;
                    const next = await request("threads/enqueue", {
                      ...queueTarget,
                      text: draft,
                      clientNonce: nonce(key),
                    });
                    nonces.current.delete(key);
                    setDraft("");
                    return next;
                  })
                }
              />
            </>
          )}
          {queue ? (
            <SettingsGroup label={t("Queue")}>
              <SettingsRow
                title={
                  queue.waitingReason === "approval"
                    ? t("Waiting for approval")
                    : queue.waitingReason === "computer"
                      ? t("Waiting for computer")
                      : queue.waitingReason === "running"
                        ? t("Running")
                        : t("Ready")
                }
              />
              {queue.entries.map((entry, index) => (
                <View key={entry.id} style={{ padding: 16, gap: 10 }}>
                  <Text selectable style={{ color: tokens.foreground }}>
                    {entry.text}
                  </Text>
                  <MenuPicker
                    label={t("Actions")}
                    choices={[
                      { key: "", label: t("Choose an action") },
                      { key: "edit", label: t("Edit") },
                      { key: "cancel", label: t("Cancel message") },
                      ...(index > 0 ? [{ key: "up", label: t("Move up") }] : []),
                      ...(index + 1 < queue.entries.length
                        ? [{ key: "down", label: t("Move down") }]
                        : []),
                      ...(entry.canSteer && queue.canSteer
                        ? [{ key: "steer", label: t("Steer current run") }]
                        : []),
                      { key: "task", label: t("Start as task") },
                    ]}
                    value=""
                    onChange={(action) => {
                      if (busy) return;
                      const input = { ...queueTarget, id: entry.id, revision: queue.revision };
                      if (action === "edit") {
                        setEditingId(entry.id);
                        setDraft(entry.text);
                      }
                      if (action === "cancel")
                        void queueAction(() => request("threads/cancelQueued", input));
                      if (action === "steer")
                        void queueAction(() => request("threads/steerQueued", input));
                      if (action === "up" || action === "down")
                        void queueAction(() =>
                          request("threads/reorderQueued", {
                            ...queueTarget,
                            revision: queue.revision,
                            ids: moveQueued(queue, entry.id, action === "up" ? -1 : 1),
                          }),
                        );
                      if (action === "task")
                        void act(async () => {
                          const key = `queued-task:${entry.id}`;
                          const created = await request("tasks/startQueued", {
                            ...input,
                            clientNonce: nonce(key),
                          });
                          nonces.current.delete(key);
                          openTask(created);
                        });
                    }}
                  />
                </View>
              ))}
              {!queue.entries.length ? <SettingsRow title={t("No queued messages")} /> : null}
            </SettingsGroup>
          ) : queueQuery.isLoading ? (
            <ActivityIndicator />
          ) : null}
          <SettingsGroup label={t("Tasks")}>
            {allTasks.map((value) => (
              <SettingsRow
                key={value.id}
                title={value.prompt}
                detail={`${value.botName} · ${activityStatusLabel(value.status)}`}
                chevron="right"
                onPress={() => openTask(value)}
              />
            ))}
            {!(allTasks.length || tasks.isLoading) ? <SettingsRow title={t("No tasks")} /> : null}
            {(cursor === undefined ? tasks.data?.nextCursor : cursor) ? (
              <SettingsRow
                title={t("Load more")}
                disabled={busy}
                onPress={() =>
                  void act(async () => {
                    const page = await request("tasks/list", {
                      ...(groupId ? { groupId } : { botId: recipientId! }),
                      cursor: (cursor === undefined ? tasks.data?.nextCursor : cursor)!,
                    });
                    setMoreTasks((current) => [...current, ...page.tasks]);
                    setCursor(page.nextCursor);
                  })
                }
              />
            ) : null}
          </SettingsGroup>
          <SettingsGroup label={t("Stopped work")}>
            {(stopped.data?.runs ?? []).map((run) => (
              <View key={run.runId}>
                <SettingsRow
                  title={run.prompt}
                  detail={run.error ?? activityStatusLabel(run.status)}
                />
                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                  <NativeActionButton
                    label={run.recoveredTaskId ? t("Open conversation") : t("Start as task")}
                    prominence="plain"
                    disabled={busy}
                    onPress={() =>
                      run.recoveredTaskId
                        ? router.push({
                            pathname: "/task-conversation",
                            params: { taskId: run.recoveredTaskId },
                          })
                        : void act(async () => {
                            const key = `recover:${run.runId}`;
                            const created = await request("tasks/recover", {
                              runId: run.runId,
                              botId: run.botId,
                              clientNonce: nonce(key),
                            });
                            nonces.current.delete(key);
                            openTask(created);
                          })
                    }
                  />
                </View>
              </View>
            ))}
            {!stopped.data?.runs.length && !stopped.isLoading ? (
              <SettingsRow title={t("No stopped work")} />
            ) : null}
          </SettingsGroup>
        </>
      ) : (
        <Text style={{ color: tokens.destructive }}>{t("Conversation link is incomplete")}</Text>
      )}
    </ScrollView>
  );
}
