import type { ThreadQueue } from "@rakazo/contracts";
import { queueWaiting } from "@rakazo/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type QueueConversationTarget = {
  botId?: string;
  groupId?: string;
  taskId?: string;
  recipientBotId?: string;
};

/** The server owns queue order and claim state; local edits never replace that state. */
export function useThreadQueue(
  rpc: ReturnType<typeof createSpaceRpc>,
  conversation: string | QueueConversationTarget | undefined,
  cursor: number | undefined,
) {
  const input = typeof conversation === "string" ? { botId: conversation } : conversation;
  const botId = input
    ? [input.botId, input.groupId, input.taskId, input.recipientBotId].join(":")
    : undefined;
  const targetInput = useMemo(() => input, [botId]);
  const [state, setState] = useState<{
    botId: string;
    queue: ThreadQueue;
    readOrder: number;
  } | null>(null);
  const readOrder = useRef(0);
  const [error, setError] = useState<{ botId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = useRef(botId);
  scope.current = botId;
  const mutation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const commit = useCallback((target: string, next: ThreadQueue, order: number) => {
    if (!mounted.current || scope.current !== target) return;
    setState((previous) =>
      previous?.botId === target &&
      (previous.queue.revision > next.revision ||
        (previous.queue.revision === next.revision && previous.readOrder > order))
        ? previous
        : { botId: target, queue: next, readOrder: order },
    );
  }, []);
  const refresh = useCallback(async () => {
    if (!botId) return;
    const order = ++readOrder.current;
    try {
      commit(botId, await rpc.threads.queue(targetInput!), order);
    } catch (cause) {
      if (mounted.current && scope.current === botId) setError({ botId, text: errorText(cause) });
    }
  }, [rpc, botId, commit, targetInput]);
  useEffect(() => {
    setError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    const reread = () => void refresh();
    window.addEventListener("online", reread);
    window.addEventListener("focus", reread);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", reread);
      window.removeEventListener("focus", reread);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 250);
    return () => window.clearTimeout(timer);
  }, [cursor, refresh]);

  async function mutate(action: (target: string) => Promise<ThreadQueue>) {
    if (!botId || mutation.current) return false;
    const target = botId;
    mutation.current = true;
    setBusy(true);
    setError(null);
    const order = ++readOrder.current;
    try {
      commit(target, await action(target), order);
      return true;
    } catch (cause) {
      if (mounted.current && scope.current === target) {
        setError({ botId: target, text: errorText(cause) });
        // A worker or another client may have claimed/edited this entry. Keep the editor's draft.
        await refresh();
      }
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const queue = state && state.botId === botId ? state.queue : null;
  const waiting = queue ? queueWaiting(queue) : undefined;
  const path = input?.taskId
    ? input.botId
      ? `/app/${encodeURIComponent(input.botId)}/tasks/${encodeURIComponent(input.taskId)}`
      : window.location.pathname
    : input?.groupId
      ? `/app/g/${encodeURIComponent(input.groupId)}`
      : input?.botId
        ? `/app/${encodeURIComponent(input.botId)}`
        : undefined;
  return {
    queue,
    waitingHref:
      waiting?.action && waiting.messageId && path
        ? `${path}?${new URLSearchParams({ m: waiting.messageId })}`
        : undefined,
    error: error && error.botId === botId ? error.text : null,
    busy,
    enqueue: (text: string, clientNonce: string) =>
      mutate(() => rpc.threads.enqueue({ ...targetInput!, text, clientNonce })),
    update: (id: string, revision: number, text: string) =>
      mutate(() => rpc.threads.updateQueued({ ...targetInput!, id, revision, text })),
    cancel: (id: string, revision: number) =>
      mutate(() => rpc.threads.cancelQueued({ ...targetInput!, id, revision })),
    reorder: (ids: string[], revision: number) =>
      mutate(() => rpc.threads.reorderQueued({ ...targetInput!, ids, revision })),
    steer: (id: string, revision: number) =>
      mutate(() => rpc.threads.steerQueued({ ...targetInput!, id, revision })),
  };
}
