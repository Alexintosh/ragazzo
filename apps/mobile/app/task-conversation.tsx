import type { RunStatus } from "@rakazo/contracts";
import {
  abortableDelay,
  answerableAskMessageIds,
  appendNewerThreadPage,
  dismissableAskMessageIds,
  forwardProbeAfterPage,
  isRunTerminalEvent,
  isRunWaitingOnUser,
  isRunWorking,
  newClientId,
  openThreadWindow,
  threadWindowMessages,
} from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import type { ImageArtifactPreviewTarget } from "../components/image-artifact-viewer";
import { ImageArtifactViewer } from "../components/image-artifact-viewer";
import type { MarkdownArtifactPreviewTarget } from "../components/markdown-artifact-preview";
import { MarkdownArtifactPreview } from "../components/markdown-artifact-preview";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { MessageBubble } from "../components/thread/message-bubble";
import { activityStatusLabel } from "../lib/activity";
import type { MobileMessage, MobileSnapshot } from "../lib/api";
import {
  applyMobileThreadEvent,
  mergeMobileSnapshot,
  prependMobileMessagePage,
  selectedSpaceId,
  selectSpace,
  subscribeThread,
} from "../lib/api";
import { useAppForeground } from "../lib/app-foreground";
import { createConversationRequest } from "../lib/conversation-work";
import { useI18n } from "../lib/i18n";
import { dismissThreadNotifications, setOpenNotificationThread } from "../lib/live-notifications";
import { native, useMobileTokens } from "../lib/native";
import { threadSpaceRequest, threadSpaceSwitchResult } from "../lib/notification-open";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { useThreadAttachments } from "../lib/thread-attachments";
import { errorText } from "../lib/user-error";

export default function TaskConversation() {
  const { taskId, spaceId, messageId } = useLocalSearchParams<{
    taskId?: string;
    spaceId?: string | string[];
    messageId?: string;
  }>();
  const focused = useIsFocused();
  const [space, setSpace] = useState(selectedSpaceId);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const decision = threadSpaceRequest(spaceId, space);
  useEffect(() => {
    if (!focused) return;
    const next = threadSpaceRequest(spaceId, selectedSpaceId());
    let cancelled = false;
    setFailed(next.action === "unavailable");
    if (next.action === "show") setSpace(selectedSpaceId());
    if (next.action === "switch")
      void selectSpace(next.spaceId)
        .then((changed) => {
          if (cancelled) return;
          if (threadSpaceSwitchResult(next.spaceId, changed, selectedSpaceId()) === "ready")
            setSpace(next.spaceId);
          else setFailed(true);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    return () => {
      cancelled = true;
    };
  }, [focused, spaceId]);
  if (decision.action !== "show" || failed)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
        }}
      >
        {failed ? (
          <>
            <Text style={{ color: tokens.destructive }}>{t("Could not switch spaces")}</Text>
            <NativeActionButton label={t("Return to inbox")} onPress={() => router.replace("/")} />
          </>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  return (
    <TaskThread key={`${taskId}:${space}:${messageId}`} taskId={taskId} messageId={messageId} />
  );
}

function TaskThread({ taskId, messageId }: { taskId?: string; messageId?: string }) {
  const [request] = useState(createConversationRequest);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const snapshotRef = useRef<MobileSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<MarkdownArtifactPreviewTarget | null>(null);
  const [image, setImage] = useState<ImageArtifactPreviewTarget | null>(null);
  const nonce = useRef<{ text: string; value: string } | null>(null);
  const uploads = useRef(new Map<string, string>());
  const task = useQuery(
    { ...rpcQuery("tasks/get", { taskId: taskId! }), enabled: Boolean(taskId) },
    queryClient,
  );
  const me = useQuery(rpcQuery("me"), queryClient);
  const bots = useQuery(rpcQuery("bots/list"), queryClient);
  const attachments = useThreadAttachments({ taskId, readOnly: false, uploadConfig: me.data });
  const target = { taskId: taskId! };
  function commit(value: MobileSnapshot) {
    if (
      snapshotRef.current?.threadId === value.threadId &&
      (value.cursor ?? -1) < (snapshotRef.current.cursor ?? -1)
    )
      return;
    snapshotRef.current = value;
    setSnapshot(value);
  }
  const expanded = useRef(false);
  const jumpDone = useRef(false);
  const jumped = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const pinned = useRef<{ cursor: number; probe: number; coverage?: number } | null>(null);
  const [hasNewer, setHasNewer] = useState(false);
  function refreshSnapshot(next: MobileSnapshot) {
    commit(mergeMobileSnapshot(snapshotRef.current, next, expanded.current));
  }

  useEffect(() => {
    if (!taskId || !focused || !foreground) return;
    const abort = new AbortController();
    let generation = 0;
    async function refresh() {
      const requested = ++generation;
      const next = await request("threads/get", { taskId }, { signal: abort.signal });
      if (!abort.signal.aborted && requested === generation) {
        if (messageId && !jumpDone.current) {
          const page = await request(
            "threads/messages",
            { taskId, around: { messageId } },
            { signal: abort.signal },
          );
          if (abort.signal.aborted || requested !== generation) return next;
          jumpDone.current = true;
          expanded.current = true;
          const opened = openThreadWindow<MobileMessage, MobileSnapshot>(next, page);
          pinned.current =
            opened.newerCursor == null
              ? null
              : { cursor: opened.newerCursor, probe: opened.newerCursor + 1 };
          setHasNewer(Boolean(pinned.current));
          commit(opened.snapshot);
        } else refreshSnapshot(next);
      }
      return next;
    }
    void (async () => {
      while (!abort.signal.aborted && request.isCurrent()) {
        try {
          const initial = await refresh();
          if (!abort.signal.aborted) setError(null);
          await request("threads/markRead", { taskId });
          void setOpenNotificationThread({ taskId, threadId: initial.threadId }).catch(
            () => undefined,
          );
          void dismissThreadNotifications({ taskId, threadId: initial.threadId }).catch(
            () => undefined,
          );
          await subscribeThread(
            { taskId },
            initial.cursor,
            (event) => {
              if (abort.signal.aborted || !request.isCurrent()) return;
              const next = applyMobileThreadEvent(snapshotRef.current, event);
              if (next) commit(next);
              if (
                event.type === "thread.queue.updated" ||
                event.type === "run.waiting_input" ||
                event.type === "computer.takeover.requested" ||
                isRunTerminalEvent(event)
              ) {
                void refresh().catch(() => undefined);
                void task.refetch();
              }
            },
            abort.signal,
          );
        } catch (cause) {
          if (!abort.signal.aborted) setError(errorText(cause));
        }
        await abortableDelay(2_000, abort.signal).catch(() => undefined);
      }
    })();
    return () => {
      abort.abort();
      generation++;
      void setOpenNotificationThread(null).catch(() => undefined);
    };
  }, [taskId, focused, foreground]);

  async function perform(action: () => Promise<unknown>, latest = false) {
    if (busyRef.current || !taskId) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (latest) {
        pinned.current = null;
        setHasNewer(false);
        expanded.current = false;
      }
      const next = await request("threads/get", target);
      refreshSnapshot(next);
      void task.refetch();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const answerable = answerableAskMessageIds(snapshot);
  const dismissable = dismissableAskMessageIds(snapshot, me.data?.userId);
  const working = isRunWorking(snapshot?.run?.status) || isRunWaitingOnUser(snapshot?.run?.status);
  const botId = task.data?.botId ?? snapshot?.botId ?? "";
  return (
    <>
      <Stack.Screen options={glassHeaderOptions(task.data?.prompt ?? t("Task"))} />
      <ScrollView
        ref={scroll}
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 20, gap: 18 }}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          <NativeActionButton
            label={t("Conversation work")}
            prominence="plain"
            onPress={() => router.push({ pathname: "/conversation-work", params: target })}
          />
          <NativeActionButton
            label={t("Files")}
            prominence="plain"
            onPress={() => router.push({ pathname: "/conversation-files", params: target })}
          />
        </View>
        {task.data ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {task.data.botName} ·{" "}
            {activityStatusLabel((snapshot?.run?.status ?? task.data.status) as RunStatus)}
          </Text>
        ) : null}
        {error || task.error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error ?? errorText(task.error)}
          </Text>
        ) : null}
        {!snapshot ? <ActivityIndicator /> : null}
        {snapshot?.olderCursor != null ? (
          <NativeActionButton
            label={t("Load earlier messages")}
            prominence="plain"
            disabled={busy}
            onPress={() =>
              void perform(async () => {
                const before = snapshotRef.current?.olderCursor;
                if (before == null) return;
                const page = await request("threads/messages", { ...target, before });
                if (snapshotRef.current) {
                  expanded.current = true;
                  const next = prependMobileMessagePage(snapshotRef.current, page);
                  if (next) commit(next);
                }
              })
            }
          />
        ) : null}
        {threadWindowMessages(snapshot?.messages ?? [], pinned.current?.cursor ?? null).map(
          (message) => (
            <View
              key={message.id}
              onLayout={(event) => {
                if (message.id === messageId && !jumped.current) {
                  jumped.current = true;
                  scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
                }
              }}
              style={{
                backgroundColor: message.id === messageId ? tokens.muted : undefined,
                alignSelf: message.role === "user" ? "flex-end" : "stretch",
                width: "100%",
              }}
            >
              <MessageBubble
                message={message}
                botId={botId}
                botName={task.data?.botName}
                showBotSenderName={false}
                bots={bots.data ?? []}
                threadTarget={target}
                canAnswer={answerable.has(message.id)}
                canDismiss={dismissable.has(message.id)}
                actionProps={{}}
                onAnswer={async (value, answer, username, dismiss) => {
                  if (!value.runId) return;
                  await request("threads/answer", {
                    ...target,
                    runId: value.runId,
                    messageId: value.id,
                    answer,
                    ...(username ? { username } : {}),
                    ...(dismiss ? { dismiss: true } : {}),
                  });
                  await perform(async () => undefined);
                }}
                onOpenBot={(id, name) =>
                  router.push({ pathname: "/thread", params: { botId: id, name } })
                }
                onOpenComputer={(id, name) =>
                  router.push({ pathname: "/computer", params: { botId: id, name } })
                }
                onPreviewMarkdown={setMarkdown}
                onPreviewImage={setImage}
                onTogglePeerReplies={() => undefined}
                onOpenPeerChat={(peer) =>
                  router.push({ pathname: "/peer-chat", params: { botId, ...peer } })
                }
              />
            </View>
          ),
        )}
        {hasNewer ? (
          <NativeActionButton
            label={t("Load newer messages")}
            prominence="plain"
            disabled={busy}
            onPress={() =>
              void perform(async () => {
                const window = pinned.current;
                const current = snapshotRef.current;
                if (!window || !current) return;
                const page = await request("threads/messages", {
                  ...target,
                  around: { seq: window.probe },
                });
                if (pinned.current !== window || !snapshotRef.current) return;
                const reported = page.coveredThroughSeq ?? null;
                const coverage =
                  reported == null ? undefined : Math.max(window.coverage ?? reported, reported);
                const next = appendNewerThreadPage<MobileMessage, MobileSnapshot>(
                  snapshotRef.current,
                  window.cursor,
                  page,
                  coverage ?? null,
                );
                const step = forwardProbeAfterPage({
                  probe: window.probe,
                  newerCursor: window.cursor,
                  nextCursor: next.newerCursor,
                  reportedCoverage: reported,
                  carriedCoverage: window.coverage,
                });
                if (step.stalled) throw new Error(t("Could not open message"));
                pinned.current =
                  next.newerCursor == null
                    ? null
                    : {
                        cursor: next.newerCursor,
                        probe: step.probe ?? next.newerCursor + 1,
                        coverage: step.coverage,
                      };
                setHasNewer(Boolean(pinned.current));
                commit(next.snapshot);
              })
            }
          />
        ) : null}
        {snapshot?.run && "error" in snapshot.run && snapshot.run.error ? (
          <Text style={{ color: tokens.destructive }}>{snapshot.run.error}</Text>
        ) : null}
        <MenuPicker
          label={t("Attach")}
          choices={[
            { key: "", label: t("Choose a source") },
            ...attachments.attachActions.map((action) => ({
              key: action.id!,
              label: action.title,
            })),
          ]}
          value=""
          onChange={(source) => {
            if (!busy) attachments.attachFrom(source);
          }}
        />
        {attachments.attachmentNotice ? (
          <Text style={{ color: tokens.mutedForeground }}>{attachments.attachmentNotice}</Text>
        ) : null}
        <SettingsGroup>
          {attachments.activePendingAttachments.map((file) => (
            <SettingsRow
              key={file.id}
              title={file.name}
              detail={t("Remove attachment")}
              disabled={busy}
              onPress={() =>
                attachments.setPendingAttachments((current) =>
                  current.filter((item) => item.id !== file.id),
                )
              }
            />
          ))}
        </SettingsGroup>
        <TextInput
          accessibilityLabel={t("Message")}
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
            minHeight: 80,
          }}
        />
        <NativeActionButton
          label={t("Send")}
          disabled={
            (!draft.trim() && !attachments.activePendingAttachments.length) || busy || !snapshot
          }
          onPress={() =>
            void perform(async () => {
              const text = draft.trim();
              const fingerprint = JSON.stringify([
                text,
                attachments.activePendingAttachments.map((file) => file.id),
              ]);
              if (nonce.current?.text !== fingerprint)
                nonce.current = { text: fingerprint, value: newClientId() };
              const artifactIds: string[] = [];
              for (const file of attachments.activePendingAttachments) {
                let id = uploads.current.get(file.id);
                if (!id) {
                  const created = await request(
                    "artifacts/create",
                    {
                      ...target,
                      name: file.name,
                      mimeType: file.mimeType,
                      contentBase64: file.contentBase64,
                      clientNonce: `${nonce.current.value}:${file.id}`,
                    },
                    { timeoutMs: 60_000 },
                  );
                  id = created.id;
                  uploads.current.set(file.id, id);
                }
                artifactIds.push(id);
              }
              await request("threads/send", {
                ...target,
                text: text || undefined,
                artifactIds,
                clientNonce: nonce.current.value,
              });
              attachments.setPendingAttachments([]);
              uploads.current.clear();
              setDraft("");
              nonce.current = null;
            }, true)
          }
        />
        {working ? (
          <NativeActionButton
            label={t("Stop")}
            prominence="secondary"
            disabled={busy}
            onPress={() => void perform(() => request("threads/stop", target))}
          />
        ) : null}
        {error ? (
          <NativeActionButton
            label={t("Retry")}
            prominence="plain"
            disabled={busy}
            onPress={() => void perform(async () => undefined)}
          />
        ) : null}
      </ScrollView>
      {markdown ? (
        <MarkdownArtifactPreview
          threadTarget={target}
          target={markdown}
          onClose={() => setMarkdown(null)}
        />
      ) : null}
      {image ? (
        <ImageArtifactViewer threadTarget={target} target={image} onClose={() => setImage(null)} />
      ) : null}
    </>
  );
}
