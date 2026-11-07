import { useLingui } from "@lingui/react/macro";
import type { Bot, Connection, ConnectionCatalogItem, Group, Routine } from "@rakazo/contracts";
import {
  buildComposerMentionOptions,
  createRoutineMentionBatcher,
  composerMentionFromFarmingEntity,
  composerMentionMatchesQuery,
  farmingControlMentionKinds,
  mentionConnectorsFrom,
} from "@rakazo/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectedAppMarks } from "../../lib/connected-apps";
import { cronLabels } from "../../lib/cron";
import type { SpaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";

function routineListData(results: Array<{ data?: Routine[] }>) {
  return results.map((result) => result.data);
}

function connectedAppMarksOf(
  data: { catalog: ConnectionCatalogItem[] | null; connections: Connection[] | null } | undefined,
) {
  return data?.catalog && data.connections ? connectedAppMarks(data.catalog, data.connections) : [];
}

/** What the composer can @mention, and the connected apps the sidebar footer shows. */
export function useComposerMentions({
  rpc,
  queries,
  bots,
  groups,
  inGroup,
  groupId,
  integrationsOpen,
  initialBotsLoaded,
  activeBotId,
  farmingConfigured = false,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  bots: Bot[];
  groups: Group[];
  inGroup: boolean;
  groupId: string | undefined;
  integrationsOpen: boolean;
  initialBotsLoaded: boolean;
  activeBotId?: string;
  farmingConfigured?: boolean;
}) {
  const { i18n } = useLingui();
  const activeBot = bots.find((bot) => bot.id === activeBotId);
  const farmingKinds = activeBot ? farmingControlMentionKinds(activeBot, { groupId }) : [];
  const farmingScope = JSON.stringify([
    queries.farmingControl.key(),
    activeBotId,
    farmingKinds,
    farmingConfigured,
  ]);
  const [mentionRequest, setMentionRequest] = useState<{ scope: string; query: string } | null>(
    null,
  );
  const [farmingSearch, setFarmingSearch] = useState<{ scope: string; query: string } | null>(null);
  const onMentionRequested = useCallback(
    (query: string | null) => {
      setMentionRequest(query === null ? null : { scope: farmingScope, query });
    },
    [farmingScope],
  );
  useEffect(() => {
    if (!mentionRequest || mentionRequest.scope !== farmingScope) {
      setFarmingSearch(null);
      return;
    }
    const timer = window.setTimeout(
      () => setFarmingSearch(mentionRequest),
      mentionRequest.query ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [mentionRequest, farmingScope]);
  const farmingTargets = useQuery({
    ...queries.farmingControl.mentionTargets.queryOptions({
      input: {
        botId: activeBotId ?? "",
        query: farmingSearch?.scope === farmingScope ? farmingSearch.query : "",
        kinds: ["position", "wallet", "protocol"],
        limit: 100,
      },
    }),
    enabled: farmingConfigured && farmingKinds.length > 0 && farmingSearch?.scope === farmingScope,
    staleTime: 30_000,
    retry: false,
  });

  const farmingRisks = useQuery({
    ...queries.farmingControl.mentionTargets.queryOptions({
      input: { botId: activeBotId ?? "", kinds: ["risk"], limit: 100 },
    }),
    enabled:
      farmingConfigured && farmingKinds.includes("risk") && mentionRequest?.scope === farmingScope,
    staleTime: 60_000,
    retry: false,
  });
  const farmingActive =
    farmingConfigured && farmingKinds.length > 0 && mentionRequest?.scope === farmingScope;
  const farmingReads = farmingKinds.includes("risk")
    ? [farmingTargets, farmingRisks]
    : [farmingTargets];
  const farmingMentionState: "loading" | "unavailable" | "partial" | "empty" | null = !farmingActive
    ? null
    : farmingReads.some((read) => read.isError || read.data?.state === "unavailable")
      ? "unavailable"
      : farmingSearch?.query !== mentionRequest?.query ||
          farmingReads.some((read) => read.isPending)
        ? "loading"
        : farmingReads.some((read) => read.data?.state === "partial")
          ? "partial"
          : farmingReads.every(
                (read) =>
                  !(read.data?.entities ?? []).some((entity) =>
                    composerMentionMatchesQuery(
                      composerMentionFromFarmingEntity(entity),
                      mentionRequest?.query ?? "",
                    ),
                  ),
              )
            ? "empty"
            : null;
  const loadRoutineMentions = useMemo(
    () =>
      createRoutineMentionBatcher(
        (botIds, signal) => rpc.routines.listForMentions({ botIds }, { signal }),
        (botId, signal) => rpc.routines.list({ botId }, { signal }),
      ),
    [rpc],
  );
  const routineLists = useQueries({
    queries: bots.map((bot) => ({
      ...queries.routines.list.queryOptions({ input: { botId: bot.id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => loadRoutineMentions(bot.id, signal),
    })),
    combine: routineListData,
  });
  const mentionRoutines = useMemo(
    () =>
      bots.flatMap((bot, index) =>
        (routineLists[index] ?? []).map((routine) => ({ ...routine, botName: bot.name })),
      ),
    [bots, routineLists],
  );
  const composerConnections = useQuery({
    queryKey: [...queries.connections.catalog.queryKey({ input: {} }), "with-connections"],
    // The catalog call reconciles connection rows, so list them after it.
    queryFn: async () => {
      const catalog = await rpc.connections.catalog({}).catch(() => null);
      const connections = await rpc.connections.list().catch(() => null);
      return { catalog, connections };
    },
    enabled: initialBotsLoaded,
  });
  // Apps can change in the integrations overlay; leaving it refreshes what the composer offers.
  const wasIntegrationsOpen = useRef(integrationsOpen);
  useEffect(() => {
    if (wasIntegrationsOpen.current && !integrationsOpen) {
      void queryClient.invalidateQueries({ queryKey: queries.connections.key() });
    }
    wasIntegrationsOpen.current = integrationsOpen;
  }, [integrationsOpen, queries]);
  // A changed roster refreshes connection data too.
  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const connectionsRoster = useRef<string | null>(null);
  useEffect(() => {
    if (!initialBotsLoaded) return;
    const previous = connectionsRoster.current;
    connectionsRoster.current = mentionBotsKey;
    if (previous !== null && previous !== mentionBotsKey) void composerConnections.refetch();
  }, [initialBotsLoaded, mentionBotsKey]);
  const [footerLogos, setFooterLogos] = useState(() =>
    connectedAppMarksOf(composerConnections.data),
  );
  useEffect(() => {
    if (composerConnections.data?.catalog && composerConnections.data.connections) {
      setFooterLogos(connectedAppMarksOf(composerConnections.data));
    }
  }, [composerConnections.data]);
  const mentionConnectors = useMemo(() => {
    const { catalog, connections } = composerConnections.data ?? {};
    return bots.length === 0 ? [] : mentionConnectorsFrom(connections ?? [], catalog ?? []);
  }, [bots.length, composerConnections.data]);
  const composerMentionTargets = useMemo(
    () => [
      ...buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
          avatarSet: bot.avatarSet,
        })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
        cronLabels: cronLabels(i18n.locale),
      }),
      ...(farmingConfigured && farmingKinds.length && farmingSearch?.scope === farmingScope
        ? [
            ...(farmingTargets.data?.entities ?? []),
            ...(farmingKinds.includes("risk") ? (farmingRisks.data?.entities ?? []) : []),
          ].map(composerMentionFromFarmingEntity)
        : []),
    ],
    [
      bots,
      groupId,
      groups,
      i18n.locale,
      inGroup,
      mentionConnectors,
      mentionRoutines,
      farmingConfigured,
      farmingScope,
      farmingSearch,
      farmingTargets.data,
      farmingRisks.data,
    ],
  );
  return {
    composerMentionTargets,
    footerLogos,
    setFooterLogos,
    onMentionRequested,
    farmingMentionState,
    allowFarmingMentions: farmingConfigured && farmingKinds.length > 0,
  };
}
