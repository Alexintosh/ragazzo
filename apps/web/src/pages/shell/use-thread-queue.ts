import type { ThreadQueue } from "@rakazo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type QueueConversationTarget = { botId?: string; groupId?: string; taskId?: string; recipientBotId?: string };

/** The server owns queue order and claim state; local edits never replace that state. */
export function useThreadQueue(
  rpc: ReturnType<typeof createSpaceRpc>,
  conversation: string | QueueConversationTarget | undefined,
  cursor: number | undefined,
) {
  const input = typeof conversation === "string" ? { botId: conversation } : conversation;
  const botId = input ? [input.botId, input.groupId, input.taskId, input.recipientBotId].join(":") : undefined;
  const targetInput = useMemo(() => input, [botId]);
  const [state, setState] = useState<{ botId: string; queue: ThreadQueue } | null>(null);
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
  const commit = useCallback((target: string, next: ThreadQueue) => {
    if (!mounted.current || scope.current !== target) return;
    setState((previous) =>
      previous?.botId === target && previous.queue.revision > next.revision
        ? previous
        : { botId: target, queue: next },
    );
  }, []);
  const refresh = useCallback(async () => {
    if (!botId) return;
    try {
      commit(botId, await rpc.threads.queue(targetInput!));
    } catch (cause) {
      if (mounted.current && scope.current === botId) setError({ botId, text: errorText(cause) });
    }
  }, [rpc, botId, commit, targetInput]);
  useEffect(() => {
    setError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
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
    try {
      commit(target, await action(target));
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
  return {
    queue: state && state.botId === botId ? state.queue : null,
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
