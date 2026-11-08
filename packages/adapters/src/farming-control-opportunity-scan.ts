import type { FarmingControlIntelligenceInput } from "@rakazo/contracts";

type ScanInput = Extract<FarmingControlIntelligenceInput, { action: "scan" }>;
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid screen projection");
  return value as Row;
}
function grade(row: Row): string | null {
  const enrichment = row.enrichment ? object(row.enrichment) : null;
  const pharos = enrichment?.pharos ? object(enrichment.pharos) : null;
  return pharos && typeof pharos.grade === "string" && grades.includes(pharos.grade)
    ? pharos.grade
    : null;
}
function metric(row: Row, key: string): Row | null {
  const value = row.metrics && object(row.metrics)[key];
  return value ? object(value) : null;
}
function observedAt(row: Row): number {
  const value = metric(row, "apy")?.observedAtMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
const grades = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"];

/** Stream the existing screen; sampling hints are not due diligence or a safety score. */
export async function scanOpportunityPopulation(
  input: ScanInput,
  getScreen: (path: string) => Promise<unknown>,
  now: () => number = Date.now,
) {
  const startedAtMs = now();
  const rows = new Map<string, Row>();
  let criteria: Row | null = null;
  let cursor = input.cursor ?? null;
  const seenCursors = new Set<string>();
  let pagesRead = 0;
  let total: number | null = null;
  let reason: string | null = null;
  let exhausted = false;
  const maxPages = input.maxPages ?? 10;
  while (pagesRead < maxPages) {
    if (now() - startedAtMs >= 120_000) {
      reason = "scan_time_budget";
      break;
    }
    const query = new URLSearchParams({
      assetSetKey: input.assetSetKey,
      minimumTvlUsd: "1000000",
      exposureScope: "single_set",
      evmOnly: "true",
      sort: "apy",
      direction: "desc",
      limit: "100",
    });
    if (input.minimumGrade) query.set("minimumGrade", input.minimumGrade);
    if (cursor) query.set("cursor", cursor);
    let page: Row;
    try {
      page = object(await getScreen(`/intelligence/screening?${query}`));
    } catch {
      reason = "screen_page_unavailable";
      break;
    }
    const pageCriteria = object(page.criteria);
    const pagination = object(page.page);
    if (
      pageCriteria.assetSetKey !== input.assetSetKey ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      !Number.isSafeInteger(pagination.total) ||
      Number(pagination.total) < 0
    )
      throw new Error("Screen population contract mismatch");
    if (criteria !== null && JSON.stringify(criteria) !== JSON.stringify(pageCriteria)) {
      reason = "screen_criteria_changed";
      break;
    }
    if (total !== null && total !== pagination.total) {
      reason = "screen_population_changed";
      break;
    }
    criteria ??= pageCriteria;
    total = pagination.total as number;
    pagesRead += 1;
    for (const item of page.items) {
      const row: Row = {
        ...object(item),
        publicationCursor: cursor,
        publicationMinimumGrade: input.minimumGrade ?? null,
      };
      if (typeof row.opportunityId !== "string" || typeof row.positionId !== "string")
        throw new Error("Missing screened identity");
      if (rows.has(row.opportunityId)) {
        reason = "screen_population_repeated";
        break;
      }
      rows.set(row.opportunityId, row);
    }
    if (reason) break;
    const next = pagination.nextCursor;
    if (next === null) {
      cursor = null;
      exhausted = true;
      break;
    }
    if (typeof next !== "string" || !next || next.length > 2_000 || seenCursors.has(next)) {
      reason = "screen_cursor_invalid_or_repeated";
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }
  if (!exhausted && !reason) reason = "scan_page_budget";
  if (input.cursor && !reason) reason = "resumed_segment_only";
  if (exhausted && !input.cursor && total !== rows.size) reason = "screen_count_mismatch";
  const population = [...rows.values()];
  const selected = new Map<string, { row: Row; sampleReasons: string[] }>();
  function include(row: Row | undefined, sampleReason: string) {
    if (!row) return;
    const id = row.opportunityId as string;
    const existing = selected.get(id);
    if (existing) existing.sampleReasons.push(sampleReason);
    else if (selected.size < 8) selected.set(id, { row, sampleReasons: [sampleReason] });
  }
  population.slice(0, 2).forEach((row) => {
    include(row, "top_yield_in_provider_screen_order");
  });
  population
    .filter((row) => grades.includes(grade(row) ?? ""))
    .sort((a, b) => grades.indexOf(grade(a)!) - grades.indexOf(grade(b)!))
    .slice(0, 2)
    .forEach((row) => {
      include(row, "known_provider_grade_not_overall_safety");
    });
  population
    .filter((row) => observedAt(row) > 0)
    .sort((a, b) => observedAt(b) - observedAt(a))
    .slice(0, 2)
    .forEach((row) => {
      include(row, "recent_yield_observation_not_a_change_claim");
    });
  include(
    population.find((row) => metric(row, "baseApy") !== null),
    "base_yield_component_recorded_not_stability",
  );
  const selectedVenues = new Set(
    [...selected.values()].map(({ row }) => `${row.protocol ?? ""}:${row.chain ?? ""}`),
  );
  include(
    population.find((row) => !selectedVenues.has(`${row.protocol ?? ""}:${row.chain ?? ""}`)),
    "different_protocol_or_chain_for_comparison",
  );
  return {
    criteria,
    scannedAtMs: startedAtMs,
    finishedAtMs: now(),
    coverage: {
      status: exhausted && !reason ? ("complete" as const) : ("partial" as const),
      fromBeginning: !input.cursor,
      pagesRead,
      rowsRead: rows.size,
      total,
      nextCursor: cursor,
      reason,
    },
    counts: {
      fullRiskReviewUnknown: population.length,
      knownProviderGrade: population.filter((row) => grade(row) !== null).length,
      missingProviderGrade: population.filter((row) => grade(row) === null).length,
      baseYieldComponentRecorded: population.filter((row) => metric(row, "baseApy") !== null)
        .length,
    },
    finalists: [...selected.values()].map(
      ({ row, sampleReasons }): Row & { sampleReasons: string[] } => ({ ...row, sampleReasons }),
    ),
    analysisComplete: false,
    limitations: [
      "For publication pass a finalist's publicationCursor when non-null, publicationMinimumGrade when present, and the exact criteria.assetSetVersionId. These bind rereading its original 100-row page. No publication occurs during this read.",
      "Coverage describes streamed screening rows, not completed analysis of every candidate. Finalists are a bounded deterministic sample for deeper review, not an investment ranking.",
      "Provider grades do not establish full risk, liquidity, costs, capacity, withdrawal feasibility or completed due diligence. Missing grade remains unknown.",
      "Recent observation time does not establish a new opportunity, improved yield or material change. Compare actual previous evidence before making those claims.",
      "A recorded base-yield component does not establish incentive stability. Preserve each source metric's unit, methodology and observation time.",
    ],
  };
}
