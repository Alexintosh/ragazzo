import type { RpcOutput } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { useI18n } from "./i18n";
import { errorText } from "./user-error";

export function useRoleplayStoryMode(botId: string | undefined, refreshKey?: unknown) {
  const { t } = useI18n();
  const [state, setState] = useState<RpcOutput<"bots/roleplayMedia"> | null>(null);
  const [loadedBotId, setLoadedBotId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const saving = useRef(false);
  const generation = useRef(0);
  const loadError = useRef("");
  loadError.current = t("Could not load story mode");
  useEffect(() => {
    if (!botId) return;
    const request = ++generation.current;
    void rpc("bots/roleplayMedia", { botId })
      .then((next) => {
        if (request === generation.current) {
          setState(next);
          setLoadedBotId(botId);
          setFailure(null);
        }
      })
      .catch((error) => {
        if (request === generation.current) setFailure(errorText(error, loadError.current));
      });
    return () => {
      generation.current++;
    };
  }, [botId, refreshKey, retry]);
  async function toggle() {
    if (!botId || loadedBotId !== botId || !state || saving.current) return;
    saving.current = true;
    setPending(true);
    setFailure(null);
    const request = ++generation.current;
    try {
      const next = await rpc("bots/updateRoleplayStoryMode", {
        botId,
        enabled: !state.storyMode,
        historyGeneration: state.historyGeneration,
        expectedRevision: state.revision,
      });
      if (request === generation.current) setState(next);
    } catch (error) {
      if (request === generation.current)
        setFailure(errorText(error, t("Could not update story mode")));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return {
    state: loadedBotId === botId ? state : null,
    pending,
    failure,
    toggle,
    retry: () => setRetry((value) => value + 1),
  };
}
