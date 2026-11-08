import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { BookOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type State = Awaited<ReturnType<typeof rpc.bots.roleplayMedia>>;
export function RoleplayStoryMode({
  botId,
  refreshKey,
  compact = false,
}: {
  botId: string;
  refreshKey?: unknown;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<State | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const saving = useRef(false);
  const loadError = useRef("");
  loadError.current = t`Could not load story mode`;
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === botId) setRetry((value) => value + 1);
    };
    window.addEventListener("roleplay-story-mode-changed", changed);
    return () => window.removeEventListener("roleplay-story-mode-changed", changed);
  }, [botId]);
  useEffect(() => {
    const request = ++generation.current;
    setFailure(null);
    void rpc.bots
      .roleplayMedia({ botId })
      .then((next) => {
        if (request === generation.current) setState(next);
      })
      .catch((error) => {
        if (request === generation.current) setFailure(errorText(error, loadError.current));
      });
    return () => {
      generation.current++;
    };
  }, [botId, refreshKey, retry]);
  async function toggle() {
    if (!state || saving.current) return;
    saving.current = true;
    setPending(true);
    setFailure(null);
    const request = ++generation.current;
    try {
      const next = await rpc.bots.updateRoleplayStoryMode({
        botId,
        enabled: !state.storyMode,
        historyGeneration: state.historyGeneration,
        expectedRevision: state.revision,
      });
      if (request === generation.current) {
        setState(next);
        window.dispatchEvent(new CustomEvent("roleplay-story-mode-changed", { detail: botId }));
      }
    } catch (error) {
      if (request === generation.current) {
        setFailure(errorText(error, t`Could not update story mode`));
      }
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <div className="pointer-events-auto min-w-0 space-y-2">
      <Button
        variant={state?.storyMode ? "secondary" : "ghost"}
        disabled={!state || pending}
        aria-pressed={state?.storyMode ?? false}
        onClick={() => void toggle()}
      >
        <BookOpen className="size-4" />
        {t`Story mode`}
      </Button>
      {!compact && state?.storyMode && state.scene ? (
        <p className="max-w-64 whitespace-pre-wrap text-sm text-muted-foreground">{state.scene}</p>
      ) : null}
      {failure ? (
        <div role="alert" className="text-sm text-destructive">
          {failure}
          <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>{t`Retry`}</Button>
        </div>
      ) : null}
    </div>
  );
}
