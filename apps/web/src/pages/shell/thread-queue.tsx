import { useLingui } from "@lingui/react/macro";
import type { ThreadQueue } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { errorText } from "../../lib/user-error";

type QueueActions = {
  queue: ThreadQueue | null;
  error: string | null;
  busy: boolean;
  update: (id: string, revision: number, text: string) => Promise<boolean>;
  cancel: (id: string, revision: number) => Promise<boolean>;
  reorder: (ids: string[], revision: number) => Promise<boolean>;
  steer: (id: string, revision: number) => Promise<boolean>;
  startTask?: (id: string, revision: number, clientNonce: string) => Promise<void>;
};

export function ThreadQueuePanel({
  queue,
  error,
  busy,
  update,
  cancel,
  reorder,
  steer,
  startTask,
}: QueueActions) {
  const { t } = useLingui();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startLock = useRef(false);
  const startNonces = useRef(new Map<string, string>());
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    text: string;
    revision: number;
    retry?: boolean;
  } | null>(null);
  if (!queue?.entries.length && !error && !startError && !editing) return null;
  const reason =
    queue?.waitingReason === "approval"
      ? t`Waiting for approval`
      : queue?.waitingReason === "computer"
        ? t`Waiting for computer`
        : queue?.waitingReason === "running"
          ? t`Waiting for current work`
          : null;
  const editAvailable = queue?.entries.some((entry) => entry.id === editing?.id);
  return (
    <div className="pointer-events-auto px-3 pb-2 md:px-[max(1.5rem,calc((100%_-_60rem)/2))]">
      {error || startError ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error ?? startError}
        </p>
      ) : null}
      <details
        data-testid="thread-queue"
        className="rounded-xl border border-border bg-background px-3 py-2"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t`Queued`} · {queue?.entries.length ?? 0}
        </summary>
        {reason ? <p className="pt-2 text-xs text-muted-foreground">{reason}</p> : null}
        <ol className="rk-scroll max-h-64 divide-y divide-border overflow-y-auto">
          {queue?.entries.map((entry, index) => (
            <li key={entry.id} className="py-2">
              <span className="text-xs text-muted-foreground">{entry.botName}</span>
              {editing?.id === entry.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const draft = editing;
                    void update(
                      draft.id,
                      draft.retry ? queue.revision : draft.revision,
                      draft.text,
                    ).then((saved) => {
                      if (saved) setEditing(null);
                      else
                        setEditing((current) =>
                          current?.id === draft.id ? { ...current, retry: true } : current,
                        );
                    });
                  }}
                >
                  <textarea
                    aria-label={t`Edit queued message`}
                    disabled={busy || starting}
                    className="my-2 w-full rounded border border-border bg-background p-2 text-sm"
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  />
                  <Button
                    size="sm"
                    disabled={busy || starting || !editing.text.trim()}
                    type="submit"
                  >{t`Save`}</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || starting}
                    onClick={() => setEditing(null)}
                  >{t`Discard`}</Button>
                </form>
              ) : (
                <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{entry.text}</p>
              )}
              <div className="flex flex-wrap gap-1 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || starting || Boolean(editing)}
                  onClick={() => {
                    setExpanded(true);
                    setEditing({ id: entry.id, text: entry.text, revision: queue.revision });
                  }}
                >{t`Edit`}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t`Move up`}
                  disabled={busy || starting || Boolean(editing) || index === 0}
                  onClick={() => {
                    const ids = queue.entries.map((item) => item.id);
                    [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                    void reorder(ids, queue.revision);
                  }}
                >{t`Move up`}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t`Move down`}
                  disabled={
                    busy || starting || Boolean(editing) || index === queue.entries.length - 1
                  }
                  onClick={() => {
                    const ids = queue.entries.map((item) => item.id);
                    [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
                    void reorder(ids, queue.revision);
                  }}
                >{t`Move down`}</Button>
                {startTask ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || starting || Boolean(editing)}
                    onClick={() => {
                      if (startLock.current) return;
                      startLock.current = true;
                      setStarting(true);
                      setStartError(null);
                      let nonce = startNonces.current.get(entry.id);
                      if (!nonce) {
                        nonce = newClientId();
                        startNonces.current.set(entry.id, nonce);
                      }
                      void startTask(entry.id, queue.revision, nonce)
                        .catch((cause) => setStartError(errorText(cause)))
                        .finally(() => {
                          startLock.current = false;
                          setStarting(false);
                        });
                    }}
                  >{t`Start as task`}</Button>
                ) : null}
                {queue.canSteer && entry.canSteer ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || starting || Boolean(editing)}
                    onClick={() => void steer(entry.id, queue.revision)}
                  >{t`Steer`}</Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || starting || Boolean(editing)}
                  onClick={() => void cancel(entry.id, queue.revision)}
                >{t`Cancel`}</Button>
              </div>
            </li>
          ))}
        </ol>
        {editing && !editAvailable ? (
          <div className="py-2">
            <p className="text-sm text-muted-foreground">{t`This message has left the queue.`}</p>
            <textarea
              aria-label={t`Edit queued message`}
              className="my-2 w-full rounded border border-border bg-background p-2 text-sm"
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            />
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t`Discard`}</Button>
          </div>
        ) : null}
      </details>
    </div>
  );
}
