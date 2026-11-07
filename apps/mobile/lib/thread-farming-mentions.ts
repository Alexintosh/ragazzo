import type { MobileBot } from "./api";
import {
  composerMentionFromFarmingEntity,
  composerMentionMatchesQuery,
  farmingControlMentionKinds,
} from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { queryClient, rpcQuery } from "./query";

/** FC catalog reads begin only when the owner opens the ordinary @ picker. */
export function useThreadFarmingMentions(
  owner: string,
  bot: MobileBot | undefined,
  groupId?: string,
) {
  const kinds = bot?.spaceId
    ? farmingControlMentionKinds(
        { id: bot.id, spaceId: bot.spaceId, spawnKey: bot.spawnKey },
        { groupId },
      )
    : [];
  const scope = JSON.stringify([owner, bot?.id, kinds]);
  const [request, setRequest] = useState<{ scope: string; query: string } | null>(null);
  const [search, setSearch] = useState<{ scope: string; query: string } | null>(null);
  const onMentionRequested = useCallback(
    (query: string | null) => {
      setRequest(query === null ? null : { scope, query });
    },
    [scope],
  );
  useEffect(() => {
    if (!request || request.scope !== scope) {
      setSearch(null);
      return;
    }
    const timer = setTimeout(() => setSearch(request), request.query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [request, scope]);
  const catalog = useQuery(
    {
      ...rpcQuery("farmingControl/mentionTargets", {
        botId: bot?.id ?? "",
        query: search?.scope === scope ? search.query : "",
        kinds: ["position", "wallet", "protocol"],
        limit: 100,
      }),
      enabled: kinds.length > 0 && search?.scope === scope,
      staleTime: 30_000,
      retry: false,
    },
    queryClient,
  );
  const risks = useQuery(
    {
      ...rpcQuery("farmingControl/mentionTargets", {
        botId: bot?.id ?? "",
        kinds: ["risk"],
        limit: 100,
      }),
      enabled: kinds.includes("risk") && request?.scope === scope,
      staleTime: 60_000,
      retry: false,
    },
    queryClient,
  );
  const active = kinds.length > 0 && request?.scope === scope;
  const reads = kinds.includes("risk") ? [catalog, risks] : [catalog];
  const farmingMentionState: "loading" | "unavailable" | "partial" | "empty" | null = !active
    ? null
    : reads.some((read) => read.isError || read.data?.state === "unavailable")
      ? "unavailable"
      : search?.query !== request?.query || reads.some((read) => read.isPending)
        ? "loading"
        : reads.some((read) => read.data?.state === "partial")
          ? "partial"
          : reads.every(
                (read) =>
                  !(read.data?.entities ?? []).some((entity) =>
                    composerMentionMatchesQuery(
                      composerMentionFromFarmingEntity(entity),
                      request?.query ?? "",
                    ),
                  ),
              )
            ? "empty"
            : null;
  return {
    farmingMentionState,
    allowFarmingMentions: kinds.length > 0,
    farmingEntities:
      kinds.length && search?.scope === scope
        ? [
            ...(catalog.data?.entities ?? []),
            ...(kinds.includes("risk") ? (risks.data?.entities ?? []) : []),
          ].map(composerMentionFromFarmingEntity)
        : [],
    onMentionRequested,
  };
}
