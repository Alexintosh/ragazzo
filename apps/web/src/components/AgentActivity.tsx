import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentActivityEntry } from "@rakazo/contracts";
import { formatCompactDuration } from "@rakazo/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight, CircleCheck, CircleX, LoaderCircle, Pause, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

/** A read-only view of the same activity returned by threads/get. */
export function AgentActivity({
  entries,
  botName,
  defaultOpen = false,
  visible = true,
}: {
  entries: readonly AgentActivityEntry[];
  botName?: (id: string) => string | undefined;
  defaultOpen?: boolean;
  visible?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(defaultOpen);
  const scroll = useRef<HTMLElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (visible && following.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, open, visible]);
  if (!entries.length && !defaultOpen) return null;
  const live = entries.some((entry) => entry.status === "running");
  const statusLabel = {
    running: t`Running`,
    completed: t`Completed`,
    error: t`Failed`,
    paused: t`Waiting`,
    stopped: t`Stopped`,
  };
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="pointer-events-auto border-t border-border bg-background px-4 py-1"
      data-testid="agent-activity"
    >
      <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-2 rounded-md text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden size={14} className="group-data-panel-open:rotate-90" />
        <span>
          <Trans>Agent activity</Trans>
        </span>
        {live ? (
          <LoaderCircle
            aria-label={t`Running`}
            size={14}
            className="animate-spin motion-reduce:animate-none"
          />
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <section
          ref={scroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the activity region.
          tabIndex={0}
          aria-label={t`Agent activity`}
          className="max-h-[35vh] overflow-y-auto overscroll-contain pb-2"
          onScroll={() => {
            const el = scroll.current;
            if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          }}
        >
          <ol className="space-y-2">
            {entries.map((entry) => {
              const Icon =
                entry.status === "running"
                  ? LoaderCircle
                  : entry.status === "error"
                    ? CircleX
                    : entry.status === "completed"
                      ? CircleCheck
                      : entry.status === "paused"
                        ? Pause
                        : Square;
              const label =
                entry.kind === "thinking"
                  ? t`Thinking`
                  : entry.kind === "reasoning"
                    ? t`Reasoning summary`
                    : entry.label;
              const name = entry.botId ? botName?.(entry.botId) : undefined;
              return (
                <li key={entry.id} data-status={entry.status} className="text-xs">
                  <div className="flex items-start gap-2">
                    <Icon
                      aria-hidden
                      size={14}
                      className={
                        entry.status === "error"
                          ? "shrink-0 text-destructive"
                          : entry.status === "running"
                            ? "shrink-0 animate-spin motion-reduce:animate-none"
                            : "shrink-0 text-muted-foreground"
                      }
                    />
                    <span className="min-w-0 flex-1 break-words">
                      {name ? `${name} · ` : ""}
                      {label}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {statusLabel[entry.status]}
                      {entry.durationMs !== undefined
                        ? ` · ${formatCompactDuration(entry.durationMs)}`
                        : ""}
                    </span>
                  </div>
                  {entry.text ? (
                    <p className="ms-5 mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                      {entry.text}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {!entries.length ? (
            <p className="text-xs text-muted-foreground">
              <Trans>No activity yet.</Trans>
            </p>
          ) : null}
        </section>
      </CollapsibleContent>
    </Collapsible>
  );
}
