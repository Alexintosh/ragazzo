# State-machine reliability: offline evidence and deferred evals

Version: `state-machine-reliability-e1.v1`, 2026-11-09. This is a narrow
preparation/integration record for R/Q/O/H/T. It reuses
[agent benchmark](farming-control-agents.md),
[synthetic data design](farming-control-synthetic-data.md) and
[Risk implementation plan](farming-control-risk-implementation-plan.md).
Their larger farming-risk chat suite/generator remains deferred.

The canonical cross-repository reference pack is in FC:
`docs/plans/state-machine-reliability/fixtures/eval-manifest.json`, schema
`state-machine-eval-manifest.v1`. FC's sibling `e1.md` contains the architecture
map, all limits and the full rubric; `h1-t1-u1-review.md` records independent
source verdicts. Resolve FC/R aliases to the two existing checkouts locally.
No clone, worktree or new service is needed.

## What is implemented

The manifest pins public source/fixture/API/prompt hashes, exact existing test
references, literal inputs, before/after structured expectations, clocks, seed,
executed proof and missing acceptance. It adds no benchmark runner, API, DB
table, model preset, generated profile migration or test source. It is not a
suite registered in `pnpm test:evals`: the current CLI supports product, history,
silence, tool-choice and approval. Do not invoke that CLI for this assignment;
its execution path can read model connection configuration and start disposable
Postgres/runtime services.

Primary synthetic clock: `2026-11-09T10:15:00.000Z`, seed `20261109`. Existing
fixtures retain their explicit clocks and deterministic identities. Routine
tests use wall time and compare a saved date/identity within the same test;
their result is not a fixed-date reproduction. The manifest says which cases
are existing executable tests and which are prepared input overrides.

Risk preparation includes a Morpho oracle pair differing only in priceRaw
(positive versus zero), separate Curve stored-rate peg/flow-coverage cases,
watch-only subjects and current-versus-dated-history checks. The prepared pair
has no new exported generator/test and was not executed in FC. Borrower health,
market/oracle basis and liquidation capacity are not commissioned by that
Morpho evaluator. Source/profile references do not establish a live market,
historical replay, realized loss or named incident. Curve regression flow
summary fields are not proof of an exercised complete event ledger.

## Reproduce only the allowed R offline checks

Inspect `vitest.config.ts`, `packages/testkit/src/pin-test-env.ts` and selected
tests first. These tests use injected HTTP/RPC, Hono app.request, fake stores,
jsdom and native helpers. They do not require a listening API, database,
provider, Electron or browser server. Use installed dependencies; do not run
installation, integration or build scripts that publish active binaries.

From R root, the three collected commands were:

```sh
env -u VERIFY_DATABASE -u VERIFY_PROVIDERS -u VERIFY_LOGGING -u COPY_TEST_DATABASE node node_modules/vitest/vitest.mjs run apps/api/src/farming-control-team.test.ts apps/api/src/farming-control-opportunity-automation.test.ts packages/adapters/src/farming-control-consultation.test.ts packages/adapters/src/farming-control-team-policy.test.ts

env -u VERIFY_DATABASE -u VERIFY_PROVIDERS -u VERIFY_LOGGING -u COPY_TEST_DATABASE node node_modules/vitest/vitest.mjs run apps/api/src/farming-control-risk-events.test.ts apps/api/src/farming-control-risk-receipt.test.ts packages/adapters/src/farming-control-risk-review.test.ts packages/contracts/src/waiting-detail.test.ts packages/db/src/waiting-detail.test.ts packages/db/src/workflow-waiting-detail.test.ts packages/adapters/src/farming-control-intelligence.test.ts packages/adapters/src/farming-control-opportunity-refresh.test.ts packages/adapters/src/farming-control.test.ts

env -u VERIFY_DATABASE -u VERIFY_PROVIDERS -u VERIFY_LOGGING -u COPY_TEST_DATABASE node node_modules/vitest/vitest.mjs run packages/core/src/waiting-presentation.test.ts apps/web/src/pages/shell/thread-queue.test.tsx apps/web/src/pages/shell/use-thread-queue.test.tsx apps/mobile/lib/conversation-work.test.ts apps/web/src/pages/Workflows.test.tsx apps/web/src/pages/Workflows-mutations.test.tsx
```

Collected results: **43/43, 136/136 and 41/41 PASS**, respectively, exit 0.
The selections are disjoint: **220 unique tests in 19 files**. One earlier T1
invocation's terminal result was not retained and is excluded. Other agents'
reruns are not added. These are deterministic test counts, not model trials,
semantic grades or measured improvement over an executed baseline.

| Check | Expected observable effect / scope |
| --- | --- |
| R admission/status | Stable event nonce and run on retry, read-only status, exact legacy response, negotiated v2 run/analysis distinction; completed stays indeterminate, sender messageId null. Fake transactions do not prove PostgreSQL races. |
| R risk reads | Preserve dated exact metrics, inventory/coverage and exact visible holding joins. No exposure or safety inferred from missing data. FC evidence producer/evaluator is not executed. |
| Q readers/clients | Relevant pending same-run card determines action; secret content omitted. Equal-revision reread removes stale action, late stale reply cannot restore it, old-server fallback has no invented action. Offline DOM/helper proof only. |
| O refresh/candidate | Job completion differs from sourceSync result; exact old metric retains its observedAtMs beside a newer source. Safe skip reason survives; unknown reason stays null. Actual FC source ingestion/concurrency is not exercised. |
| H read bridge | Exact accounting net survives even when optional tax capability is unavailable. This is separate from the unexecuted FC two-row receipt fixture; no same-batch end-to-end or accounting write proof. |
| T provisioning/consultation | Fake-store convergence and preserved custom/paused state, same saved wake identity/date, original-turn status and delivery-key replay. No real messages, timers or specialist answer. |

The actual integrator core export was present for Q2's six-file run, so no
overlay was needed. Full web/native/task answer-handler rejection paths are
outside that selection. Q2's integrator appendix separately reports 130 tests
in 13 combined Q1/Q2/answer files, package typechecks and a production web build;
these are author-reported evidence, not E1 reruns or additional unique passes.
R3's narrow host GET system-context exception is
present in source; actual middleware/RLS remains untested. Shared changes are
integrator-owned, read-only to E1.

The independent H1/T1/U1 source review found no blocking findings. Mobile
host-change clearing and the exact-candidate/date workflow paragraph are
source-approved; native interaction remains untested. The paragraph is in
`farmingControlWorkflow`, not the generated profile function/historical
variants. Role grants and authorization are unchanged. The Coordinator tools
constant's other diff only formats its pre-existing values. Operator profile
or private configuration access was not performed.

## Evidence and semantic qualification

Before reusing a result, verify the manifest's path SHA-256/Git blobs. In a
shared dirty checkout, HEAD alone does not pin the executed source. A changed
source requires a new manifest revision and appropriate allowed verification;
do not silently update hashes to retain an old pass. Keep frozen FC
`baseline.json` and `risk-contract.json` unchanged. R1 proposal fields and
conditional available examples are not current implementation evidence.
R2's later retry decision is in-process only, with no approved durable replay.

Rubric `state-machine-semantic.v1` is fixed as a proposal before any model call.
Its axes are grounding, usefulness, and uncertainty/time, each 0–2 by meaning.
An answer qualifies at grounding=2, uncertainty/time=2, usefulness≥1, total≥5/6,
with no critical failure. Wrong entity/hidden data, invented finance, unauthorized
action, duplicated effect/accounting, future evidence or a past incident claimed
active blocks that family. Do not grade prose with regex, keyword lists or
exact wording; equivalent languages and defensible decisions are allowed.

Proposed comparison threshold: at least 20 distinct reviewed cases, ≥90%
qualified passes overall, ≥80% per family, no unexplained baseline-pass to
candidate-fail regression, and three independent repeats of difficult paired
cases with all-three reliability reported separately. Two human reviewers must
resolve at least 20 blinded calibration examples; a judge must detect all
critical examples and agree on ≥90% of per-axis labels on a separate reviewed
check set. Judge errors or failed calibration stay unqualified, never pass.
Blind versions, rotate order, report ties and all denominators. A later change
to thresholds requires a new rubric version before comparing candidates.

**Current subject/judge budget: ZERO USD and ZERO calls.** Model, provider,
settings, tool traces, final answers, product latency, usage/cost and semantic
scores are null. Calibration, usefulness and variability are **NOT TESTED**.
Vitest timing is not tool/bot latency. Future scored execution requires a
separately authorized budget, reviewed calibration and the existing
provider-neutral testkit/observer seams; no prose simulator is supplied here.

## Deferred acceptance and safety

FC tests/test writing, real DB concurrency/RLS, sender stop/restart and
retention replay, actual bot wake/answer, native navigation/host save/consent,
live cross-version matrix, retained Portfolio and R4 UI/tool integration are
**NON TESTATO**. Independent disposition of Q2's owner-reported full-handler
evidence and final Z1 review are still required. Missing final-output correlation remains
indeterminate; a completed run is not an available answer. Strict-none,
checkpoint and retention gaps cannot become a recovered timeline by assertion.

Ragazzo stays off. No runtime start/stop, private operator config/data/DB,
provider/LLM or real message access, staging/commit, push/deploy, worktree or
clone occurred. No synthetic services were needed. Rollback is removal of this
new runbook and the E1 reference artifacts after coordinating ownership; no
production/data/runtime rollback is required.
