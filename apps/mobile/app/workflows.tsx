import type { WorkflowNodeState, WorkflowRun } from "@rakazo/contracts";
import { canRecoverWorkflowNode } from "@rakazo/contracts";
import { newClientId, workflowWaiting } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Stack, useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { useAppForeground } from "../lib/app-foreground";
import {
  createConversationRequest,
  waitingActionLabel,
  waitingLabel,
} from "../lib/conversation-work";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function Workflows() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const workflows = useQuery(rpcQuery("workflows/list", {}), queryClient);
  const [selected, setSelected] = useState("");
  const workflowId = selected || workflows.data?.workflows[0]?.id;
  useFocusEffect(
    useCallback(() => {
      void workflows.refetch();
    }, []),
  );
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 20, gap: 20 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(t("Workflows"))} />
      {workflows.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {errorText(workflows.error)}
        </Text>
      ) : null}
      {workflows.isLoading ? <ActivityIndicator /> : null}
      <NativeActionButton
        label={t("Refresh")}
        prominence="plain"
        onPress={() => void workflows.refetch()}
      />
      {workflows.data?.workflows.length ? (
        <MenuPicker
          label={t("Workflow")}
          choices={workflows.data.workflows.map((workflow) => ({
            key: workflow.id,
            label: workflow.name,
          }))}
          value={workflowId ?? ""}
          onChange={setSelected}
        />
      ) : workflows.data ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No workflows")}</Text>
      ) : null}
      {workflowId ? <WorkflowDetail key={workflowId} workflowId={workflowId} /> : null}
    </ScrollView>
  );
}

function WorkflowDetail({ workflowId }: { workflowId: string }) {
  const [request] = useState(createConversationRequest);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const poll = focused && foreground ? 5_000 : false;
  const definition = useQuery(rpcQuery("workflows/get", { workflowId }), queryClient);
  const runs = useQuery(
    {
      ...rpcQuery("workflows/runs", { workflowId }),
      refetchInterval: poll,
      refetchOnReconnect: "always",
    },
    queryClient,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runId = selectedRunId ?? runs.data?.runs[0]?.id;
  const runOptions = rpcQuery("workflows/run", { runId: runId! });
  const run = useQuery(
    { ...runOptions, enabled: Boolean(runId), refetchInterval: poll, refetchOnReconnect: "always" },
    queryClient,
  );
  const receipt = useRef<WorkflowRun | null>(null);
  if (receipt.current?.id !== runId) receipt.current = null;
  if (run.data && (!receipt.current || run.data.revision >= receipt.current.revision))
    receipt.current = run.data;
  const currentRun = receipt.current;
  useFocusEffect(
    useCallback(() => {
      void runs.refetch();
      if (runId) void run.refetch();
    }, [runId, foreground]),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const nonces = useRef(new Map<string, string>());
  function nonce(key: string) {
    let value = nonces.current.get(key);
    if (!value) {
      value = newClientId();
      nonces.current.set(key, value);
    }
    return value;
  }
  async function act(action: () => Promise<WorkflowRun>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (
        !receipt.current ||
        receipt.current.id !== next.id ||
        next.revision >= receipt.current.revision
      )
        receipt.current = next;
      queryClient.setQueryData(rpcQuery("workflows/run", { runId: next.id }).queryKey, next);
      setSelectedRunId(next.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await Promise.all([runs.refetch(), definition.refetch(), ...(runId ? [run.refetch()] : [])]);
      busyRef.current = false;
      setBusy(false);
    }
  }
  function status(value: WorkflowNodeState["status"] | WorkflowRun["status"]) {
    switch (value) {
      case "pending":
        return t("Pending");
      case "queued":
        return t("Queued");
      case "running":
        return t("Running");
      case "waiting_approval":
        return t("Needs input");
      case "succeeded":
        return t("Done");
      case "failed":
        return t("Failed");
      case "cancelled":
        return t("Cancelled");
    }
  }
  const readError =
    error ??
    (definition.error || runs.error || run.error
      ? errorText(definition.error ?? runs.error ?? run.error)
      : null);
  return (
    <View style={{ gap: 20 }}>
      {readError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {readError}
        </Text>
      ) : null}
      {definition.isLoading ? <ActivityIndicator /> : null}
      {definition.data ? (
        <>
          <SettingsGroup label={t("Steps")}>
            {definition.data.graph.nodes.map((node) => (
              <SettingsRow
                key={node.id}
                title={node.label}
                detail={[
                  node.prompt,
                  ...definition
                    .data!.graph.edges.filter((edge) => edge.to === node.id)
                    .map((edge) =>
                      t("After {step}", {
                        step:
                          definition.data!.graph.nodes.find(
                            (candidate) => candidate.id === edge.from,
                          )?.label ?? edge.from,
                      }),
                    ),
                ].join("\n")}
              />
            ))}
          </SettingsGroup>
          <NativeActionButton
            label={t("Start workflow")}
            disabled={busy}
            onPress={() =>
              void act(async () => {
                const workflow = definition.data!;
                const key = `start:${workflow.id}:${workflow.revision}`;
                const next = await request("workflows/start", {
                  workflowId: workflow.id,
                  revision: workflow.revision,
                  clientNonce: nonce(key),
                });
                nonces.current.delete(key);
                return next;
              })
            }
          />
        </>
      ) : null}
      {runs.data?.runs.length ? (
        <MenuPicker
          label={t("Runs")}
          choices={runs.data.runs.map((value) => ({
            key: value.id,
            label: `${new Date(value.createdAt).toLocaleString()} · ${status(value.status)}`,
          }))}
          value={runId ?? ""}
          onChange={(value) => {
            if (!busyRef.current) setSelectedRunId(value);
          }}
        />
      ) : null}
      {currentRun ? (
        <>
          <Text accessibilityRole="header" style={{ color: tokens.foreground }}>
            {status(currentRun.status)}
          </Text>
          <SettingsGroup>
            {currentRun.graph.nodes.map((node) => {
              const state = currentRun.nodes.find((value) => value.nodeId === node.id);
              if (!state) return null;
              const waiting = workflowWaiting(state);
              return (
                <View key={node.id}>
                  <SettingsRow
                    title={node.label}
                    detail={[waiting ? waitingLabel(waiting) : status(state.status), state.error]
                      .filter(Boolean)
                      .join(" · ")}
                    chevron={state.taskId ? "right" : undefined}
                    onPress={
                      state.taskId
                        ? () =>
                            router.push({
                              pathname: "/task-conversation",
                              params: { taskId: state.taskId! },
                            })
                        : undefined
                    }
                  />
                  {waiting?.action && waiting.messageId && state.taskId ? (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                      <NativeActionButton
                        label={waitingActionLabel(waiting)}
                        prominence="plain"
                        disabled={busy}
                        onPress={() =>
                          router.push({
                            pathname: "/task-conversation",
                            params: { taskId: state.taskId!, messageId: waiting.messageId! },
                          })
                        }
                      />
                    </View>
                  ) : null}
                  {canRecoverWorkflowNode(state) && currentRun.status !== "running" ? (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                      <NativeActionButton
                        label={t("Recover step")}
                        prominence="plain"
                        disabled={busy}
                        onPress={() =>
                          void act(async () => {
                            const key = `recover:${currentRun.id}:${node.id}:${currentRun.revision}`;
                            const next = await request("workflows/recover", {
                              runId: currentRun.id,
                              revision: currentRun.revision,
                              nodeId: node.id,
                              clientNonce: nonce(key),
                            });
                            nonces.current.delete(key);
                            return next;
                          })
                        }
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </SettingsGroup>
          {currentRun.status === "running" ? (
            <NativeActionButton
              label={t("Cancel workflow")}
              prominence="secondary"
              disabled={busy}
              onPress={() =>
                void act(() =>
                  request("workflows/cancel", {
                    runId: currentRun.id,
                    revision: currentRun.revision,
                  }),
                )
              }
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
