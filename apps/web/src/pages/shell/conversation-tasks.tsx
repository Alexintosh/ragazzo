import { useLingui } from "@lingui/react/macro";
import type { Bot, ConversationTask, StoppedConversationRun } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { statusLabel } from "../ActivityList";
import type { QueueConversationTarget } from "./use-thread-queue";

export const taskConversationPath = (task: Pick<ConversationTask, "botId" | "id">) =>
  `/app/${encodeURIComponent(task.botId)}/tasks/${encodeURIComponent(task.id)}`;

export function ConversationTasks({
  rpc,
  target,
  bots,
  tasks,
  currentTask,
  onOpen,
  onChanged,
  moreTasks,
  loadingMore,
  onLoadMore,
  onOpenSource,
  visible = true,
  defaultOpen = false,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  target: QueueConversationTarget;
  bots: Bot[];
  tasks: ConversationTask[];
  currentTask?: ConversationTask;
  moreTasks?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onOpenSource?: (path: string) => void;
  onOpen: (task: ConversationTask) => void;
  onChanged: () => void;
  visible?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(defaultOpen);
  const [stopped, setStopped] = useState<StoppedConversationRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [editor, setEditor] = useState<{
    source?: StoppedConversationRun;
    botId: string;
    text: string;
    nonce: string;
    writeSubdirectory?: string;
  } | null>(null);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    if (!expanded || !visible) return;
    let alive = true;
    const refresh = () =>
      void rpc.tasks
        .stopped(target)
        .then((result) => {
          if (alive) setStopped(result.runs);
        })
        .catch((cause) => {
          if (alive) setError(errorText(cause));
        });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [expanded, visible, rpc, targetKey]);
  const relevantTasks = currentTask
    ? tasks.filter(
        (task) => task.id === currentTask.id || task.recoveryOfRunId === currentTask.runId,
      )
    : tasks;
  const sourcePath =
    currentTask?.originTaskId && currentTask.originBotId
      ? taskConversationPath({ id: currentTask.originTaskId, botId: currentTask.originBotId })
      : currentTask?.originGroupId
        ? `/app/g/${encodeURIComponent(currentTask.originGroupId)}`
        : currentTask?.originBotId
          ? `/app/${encodeURIComponent(currentTask.originBotId)}`
          : null;
  return (
    <details
      hidden={!visible}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      data-testid="conversation-tasks"
      className="pointer-events-auto rounded-xl border border-border bg-background px-3 py-2 text-sm"
    >
      <summary className="cursor-pointer text-muted-foreground">
        {currentTask ? t`Task` : t`Tasks`}
      </summary>
      {currentTask ? (
        <div className="pt-2">
          <p className="whitespace-pre-wrap break-words">{currentTask.prompt}</p>
          <p className="text-xs text-muted-foreground">
            {currentTask.botName} · {statusLabel(currentTask.status)}
          </p>
          {currentTask.recoveryOfRunId ? (
            <p className="text-xs text-muted-foreground">{t`Recovery`}</p>
          ) : null}
          {sourcePath && onOpenSource ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpenSource(sourcePath)}
            >{t`Source conversation`}</Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="pt-2 text-destructive">
          {error}
        </p>
      ) : null}
      {!editor ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              setEditor({
                botId: target.botId ?? bots[0]?.id ?? "",
                text: "",
                nonce: newClientId(),
              });
            }}
          >{t`New task`}</Button>
          <ul className="rk-scroll max-h-40 overflow-y-auto divide-y divide-border">
            {relevantTasks
              .filter((task) => task.id !== currentTask?.id)
              .map((task) => (
                <li key={task.id} className="py-1">
                  <button
                    type="button"
                    className="w-full text-start hover:underline"
                    onClick={() => onOpen(task)}
                  >
                    <span className="line-clamp-1">{task.prompt}</span>
                    <span className="text-xs text-muted-foreground">
                      {task.botName} · {statusLabel(task.status)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {moreTasks ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={loadingMore}
              onClick={onLoadMore}
            >{t`Older tasks`}</Button>
          ) : null}
          {stopped.map((run) => (
            <div key={run.runId} className="border-t border-border py-2">
              <p className="line-clamp-2 whitespace-pre-wrap">{run.prompt}</p>
              <p className="text-xs text-muted-foreground">
                {run.botName} · {statusLabel(run.status)}
              </p>
              {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
              {run.recoveredTaskId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const task = tasks.find((item) => item.id === run.recoveredTaskId);
                    if (task) onOpen(task);
                    else if (run.recoveredTaskId) {
                      setBusy(true);
                      setError(null);
                      void rpc.tasks
                        .get({ taskId: run.recoveredTaskId })
                        .then(onOpen)
                        .catch((cause) => setError(errorText(cause)))
                        .finally(() => setBusy(false));
                    }
                  }}
                  disabled={busy}
                >{t`Open recovery`}</Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setEditor({
                      source: run,
                      botId: bots.some((bot) => bot.id === run.botId) ? run.botId : "",
                      text: run.prompt,
                      nonce: newClientId(),
                    });
                  }}
                >{t`Recover or reassign`}</Button>
              )}
            </div>
          ))}
        </>
      ) : (
        <form
          className="space-y-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (lock.current || !editor.text.trim() || !editor.botId) return;
            lock.current = true;
            setBusy(true);
            setError(null);
            const taskInput = {
              botId: editor.botId,
              text: editor.text,
              clientNonce: editor.nonce,
              ...(target.groupId
                ? { originGroupId: target.groupId }
                : target.botId
                  ? { originBotId: target.botId }
                  : {}),
            };
            const request = editor.source
              ? rpc.tasks.recover({
                  runId: editor.source.runId,
                  botId: editor.botId,
                  text: editor.text,
                  clientNonce: editor.nonce,
                })
              : editor.writeSubdirectory
                ? rpc.tasks.createScoped({
                    ...taskInput,
                    writeSubdirectory: editor.writeSubdirectory,
                  })
                : rpc.tasks.create(taskInput);
            void request
              .then((task) => {
                setEditor(null);
                onChanged();
                onOpen(task);
              })
              .catch((cause) => setError(errorText(cause)))
              .finally(() => {
                lock.current = false;
                setBusy(false);
              });
          }}
        >
          {editor.source ? (
            <p className="text-xs text-muted-foreground">{t`Starts a new execution. Earlier actions may already have taken effect. Review the instructions to avoid repeating them.`}</p>
          ) : null}
          <label className="block">
            {t`Bot`}
            <select
              aria-label={t`Task bot`}
              disabled={busy}
              value={editor.botId}
              onChange={(event) =>
                setEditor({ ...editor, botId: event.target.value, writeSubdirectory: undefined })
              }
              className="ms-2 rounded border border-border bg-background p-1"
            >
              <option value="" disabled>{t`Choose a bot`}</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label={t`Task instructions`}
            value={editor.text}
            disabled={busy}
            onChange={(event) => setEditor({ ...editor, text: event.target.value })}
            className="min-h-24 w-full rounded border border-border bg-background p-2"
          />
          {!editor.source &&
          bots.some(
            (bot) =>
              bot.id === editor.botId &&
              bot.runtimeKind === "codex" &&
              bot.runtimePermission === "workspace",
          ) ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">{t`Write scope`}</summary>
              <input
                aria-label={t`Project subdirectory`}
                placeholder={t`Project subdirectory`}
                disabled={busy}
                value={editor.writeSubdirectory ?? ""}
                onChange={(event) =>
                  setEditor({ ...editor, writeSubdirectory: event.target.value })
                }
                className="w-full rounded border border-border bg-background p-2"
              />
            </details>
          ) : null}
          <Button size="sm" type="submit" disabled={busy || !editor.text.trim() || !editor.botId}>
            {editor.source ? t`Start recovery` : t`Start task`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => setEditor(null)}
          >{t`Discard`}</Button>
        </form>
      )}
    </details>
  );
}
