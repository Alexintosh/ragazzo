import type {
  FarmingControlMonitoringEvidence,
  FarmingControlRiskResearch,
  FarmingControlRiskReview,
} from "@rakazo/contracts";

type Item = FarmingControlMonitoringEvidence["items"][number];
const PAGE_SIZE = 12;
const MODEL_BUDGET = 24_000;
const rank = { unknown: 0, healthy: 1, attention: 2, action_required: 3 };
const short = (value: string, limit = 300) => ({
  text: value.slice(0, limit),
  omittedCharacters: Math.max(0, value.length - limit),
});

/** Compact evidence is a model view only. Raw API/routine evidence remains unchanged. */
export function compactFarmingControlRiskReview(
  review: FarmingControlRiskReview,
  options: { inventoryOffset?: number } = {},
) {
  const evidence = review.evidence;
  const selected = review.selectionStatus === "matched";
  const offset = selected ? 0 : Math.max(0, Math.floor(options.inventoryOffset ?? 0));
  const metricSets: Array<{
    id: string;
    indicators: Record<string, string>;
    omittedIndicatorCount: number;
  }> = [];
  const seen = new Map<string, string>();
  let metricBytes = 0;
  function metrics(values: Record<string, string>) {
    const key = JSON.stringify(values);
    const previous = seen.get(key);
    if (previous) return previous;
    const indicators: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const bytes = new TextEncoder().encode(JSON.stringify({ [name]: value })).byteLength;
      if (metricBytes + bytes > 6_000 || Object.keys(indicators).length >= 24) continue;
      indicators[name] = value;
      metricBytes += bytes;
    }
    const id = `metrics-${metricSets.length + 1}`;
    metricSets.push({
      id,
      indicators,
      omittedIndicatorCount: Object.keys(values).length - Object.keys(indicators).length,
    });
    seen.set(key, id);
    return id;
  }
  function monitor(item: Item) {
    const current = [...item.current.assessments].sort((a, b) => rank[b.status] - rank[a.status]);
    const signals = [...item.trend.materialSignals].sort(
      (a, b) =>
        Number(b.direction === "worsening") - Number(a.direction === "worsening") ||
        b.throughMs - a.throughMs,
    );
    const changes = item.trend.families
      .filter(
        (family) =>
          family.first.status !== "unknown" &&
          family.last.status !== "unknown" &&
          family.first.status !== family.last.status,
      )
      .sort((a, b) => b.last.observedAtMs - a.last.observedAtMs);
    const grouped = new Map<string, Item["trend"]["families"]>();
    for (const family of item.trend.families)
      grouped.set(family.family, [...(grouped.get(family.family) ?? []), family]);
    const familySummaries = [...grouped].map(([family, groups]) => ({
      family,
      lineageCount: groups.length,
      recordedSamplesAcrossLineages: groups.reduce((sum, group) => sum + group.sampleCount, 0),
      firstObservedAtMs: Math.min(...groups.map((group) => group.first.observedAtMs)),
      lastObservedAtMs: Math.max(...groups.map((group) => group.last.observedAtMs)),
      comparableLineageCount: groups.filter(
        (group) => group.first.observedAtMs < group.last.observedAtMs,
      ).length,
    }));
    return {
      monitorKey: item.monitorKey,
      label: short(item.label),
      exposureRole: item.exposureRole,
      current: {
        status: item.current.status,
        observedAtMs: item.current.observedAtMs,
        collectedAtMs: item.current.collectedAtMs,
        totalAssessmentCount: current.length,
        assessments: current.slice(0, selected ? 16 : 8).map((assessment) => ({
          family: assessment.family,
          subjectKey: assessment.subjectKey,
          status: assessment.status,
          severity: assessment.severity,
          ...(selected
            ? { summary: short(assessment.summary), metricsRef: metrics(assessment.indicators) }
            : {}),
        })),
      },
      emergency: item.emergency,
      history: item.history,
      trend: {
        status: item.trend.status,
        totalMaterialSignalCount: signals.length,
        materialSignals: signals
          .slice(0, selected ? 8 : 3)
          .map(({ reason, ...signal }) => ({ ...signal, reason: short(reason) })),
        historicalLineageGroupCount: item.trend.families.length,
        distinctFamilyCount: grouped.size,
        familySummaries: selected ? familySummaries.slice(0, 16) : [],
        statusChangeCount: changes.length,
        statusChanges: selected
          ? changes.slice(0, 8).map((family) => ({
              family: family.family,
              lineageKey: family.lineageKey,
              sampleCount: family.sampleCount,
              first: {
                status: family.first.status,
                severity: family.first.severity,
                observedAtMs: family.first.observedAtMs,
                metricsRef: metrics(family.first.indicators),
              },
              last: {
                status: family.last.status,
                severity: family.last.severity,
                observedAtMs: family.last.observedAtMs,
                metricsRef: metrics(family.last.indicators),
              },
            }))
          : [],
      },
      limitations: item.limitations.slice(0, 8).map((value) => short(value)),
      omitted: {
        currentAssessments: Math.max(0, current.length - (selected ? 16 : 8)),
        materialSignals: Math.max(0, signals.length - (selected ? 8 : 3)),
        familySummaries: Math.max(0, familySummaries.length - (selected ? 16 : 0)),
        statusChanges: Math.max(0, changes.length - (selected ? 8 : 0)),
        limitations: Math.max(0, item.limitations.length - 8),
      },
    };
  }
  const all = evidence?.items ?? [];
  const monitors = all.slice(offset, offset + (selected ? 1 : PAGE_SIZE)).map(monitor);
  const linked = review.linkedExposure;
  const output = {
    modelView: "monitoring-risk-compact.v1",
    executionEligible: false,
    state: review.state,
    fetchedAtMs: review.fetchedAtMs,
    asOfMs: review.asOfMs,
    selectionStatus: review.selectionStatus,
    scope: selected ? "selected_monitor" : "monitoring_inventory",
    issues: review.issues.slice(0, 8).map((value) => short(value)),
    source: review.sources,
    window: evidence?.window ?? null,
    requestedFromMs: evidence?.requestedFromMs ?? null,
    population: evidence?.population ?? null,
    sourceReturnedMonitorCount: all.length,
    inventoryOffset: offset,
    nextInventoryOffset: null as number | null,
    monitors,
    metricSets,
    exposureAssociationStatus: review.exposureAssociationStatus,
    linkedExposure: linked
      ? {
          id: linked.id,
          label: short(linked.label),
          protocol: linked.protocol,
          chainId: linked.chainId,
          assetSymbol: linked.assetSymbol ?? null,
          holdingScope: linked.holdingScope ?? null,
          positions: linked.positions
            .slice(0, 8)
            .map((position) => ({ id: position.id, label: short(position.label),
              ...(position.association ? { association: position.association } : {}),
              ...(position.holding ? { holding: position.holding } : {}),
            })),
          omittedPositionCount: Math.max(0, linked.positions.length - 8),
          signals: [...linked.signals].sort((a, b) =>
            (b.positionExitQuote ? 4 : b.referenceFlow24h ? 3 : b.policyResponse ? 2 : 0) -
            (a.positionExitQuote ? 4 : a.referenceFlow24h ? 3 : a.policyResponse ? 2 : 0),
          ).slice(0, 16).map(({ label, summary, ...signal }) => ({
            ...signal, label: short(label), summary: short(summary),
          })),
          omittedSignalCount: Math.max(0, linked.signals.length - 16),
          capacityState: linked.capacityState ?? null,
          currentObservation: linked.currentObservation ?? null,
          limitations: linked.limitations.slice(0, 8).map((value) => short(value)),
          omittedLimitationCount: Math.max(0, linked.limitations.length - 8),
        }
      : null,
    linkedCurrentObservationOmitted: false,
    omittedMonitorCount: 0,
    omittedIssueCount: Math.max(0, review.issues.length - 8),
    interpretation:
      "Inventory rows require an exact monitorKey drilldown for numeric/current findings. Historical groups are aggregated by family; no comparison across runtime/configuration lineages is implied. Omission counts are not zero risk. Raw asset quantities retain raw units. executionEligible remains false.",
  };
  // Drop whole optional evidence records, never clip JSON or a decimal, if a dense subject reaches the model budget.
  while (new TextEncoder().encode(JSON.stringify(output)).byteLength > MODEL_BUDGET - 256) {
    const last = output.monitors.at(-1);
    if (!last) break;
    if (!selected && output.monitors.length > 1) {
      output.monitors.pop();
      continue;
    }
    if (last.trend.statusChanges.length) {
      last.trend.statusChanges.pop();
      last.omitted.statusChanges++;
      continue;
    }
    if (last.trend.materialSignals.length) {
      last.trend.materialSignals.pop();
      last.omitted.materialSignals++;
      continue;
    }
    if (last.trend.familySummaries.length) {
      last.trend.familySummaries.pop();
      last.omitted.familySummaries++;
      continue;
    }
    if (last.current.assessments.length) {
      last.current.assessments.pop();
      last.omitted.currentAssessments++;
      continue;
    }
    if (output.linkedExposure && output.linkedExposure.signals.length > 2) {
      output.linkedExposure.signals.pop();
      output.linkedExposure.omittedSignalCount++;
      continue;
    }
    if (output.linkedExposure?.positions.length) {
      output.linkedExposure.positions.pop();
      output.linkedExposure.omittedPositionCount++;
      continue;
    }
    if (output.linkedExposure?.currentObservation) {
      output.linkedExposure.currentObservation = null;
      output.linkedCurrentObservationOmitted = true;
      continue;
    }
    if (last.limitations.length) {
      last.limitations.pop();
      last.omitted.limitations++;
      continue;
    }
    if (output.linkedExposure?.limitations.length) {
      output.linkedExposure.limitations.pop();
      output.linkedExposure.omittedLimitationCount++;
      continue;
    }
    const metricsToTrim = [...output.metricSets]
      .reverse()
      .find((set) => Object.keys(set.indicators).length);
    if (metricsToTrim) {
      delete metricsToTrim.indicators[Object.keys(metricsToTrim.indicators).at(-1)!];
      metricsToTrim.omittedIndicatorCount++;
      continue;
    }
    if (output.issues.length) {
      output.issues.pop();
      output.omittedIssueCount++;
      continue;
    }
    break;
  }
  output.omittedMonitorCount = Math.max(0, all.length - offset - output.monitors.length);
  if (!selected && offset + output.monitors.length < all.length)
    output.nextInventoryOffset = offset + output.monitors.length;
  return output;
}

/** Keep official-source provenance while giving the model an explicit bounded excerpt per source. */
export function compactFarmingControlRiskResearch(report: FarmingControlRiskResearch) {
  return {
    ...report,
    modelView: "official-risk-research-compact.v1",
    sources: report.sources.map((source) => {
      const limit = source.key.endsWith("-news") ? 3_500 : 2_000;
      let excerpt = "";
      let bytes = 0;
      for (const character of source.text ?? "") {
        const size = new TextEncoder().encode(character).byteLength;
        if (bytes + size > limit) break;
        excerpt += character;
        bytes += size;
      }
      return {
        ...source,
        text: source.text === null ? null : excerpt,
        truncated: source.truncated || (source.text?.length ?? 0) > excerpt.length,
        sourceTextAlreadyTruncated: source.truncated,
        omittedCharactersWithinSourceProjection: Math.max(
          0,
          (source.text?.length ?? 0) - excerpt.length,
        ),
      };
    }),
  };
}
