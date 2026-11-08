# Implementation plan for the Risk benchmark

**Status: deferred.** Resume at milestone 1. The deliverable is a repeatable answer to one question: given the evidence available to a particular operator at a particular time, does Risk identify the relevant pool and position and give a useful, defensible decision?

The companion documents define the [benchmark and scoring rubric](./farming-control-agents.md) and the [synthetic generator, incident sources and worked example](./farming-control-synthetic-data.md). This plan sets the implementation order and the acceptance evidence for each milestone.

## Release scope and ownership

| Owner | Deliverable |
| --- | --- |
| Farming Control | In its testkit, generate exact synthetic protocol states and exercise the existing adapters, evaluators and evidence projection. Export the resulting typed reads as a versioned pack. |
| Ragazzo | In its existing eval runner, serve those reads to the real specialist, capture tool calls and answers, qualify the scores and compare revisions. |
| Incident researchers and independent reviewer | Produce source-linked timelines, challenge causal assumptions, confirm that controls isolate the intended change, and review what was knowable at each turn. |
| Operator and integration owner | Agree on decision rubrics, review baseline disagreements, own compatibility across the two repositories and record accepted limitations. |

The first release covers Curve stablecoin and ETH LPs including wrappers, a Morpho Blue lender and a Morpho USDC vault depositor. It includes healthy, stressed, recovering, watch-only and unobservable cases. The runtime boundary is an offline JSON pack and a disposable Ragazzo trial database. Existing FC production endpoints remain the contract. Production storage, UI, notification delivery and transaction execution are outside the release scope. Later suites for Operations, Accounting or the Coordinator can reuse the runner.

## Milestones

### 1. Fix the boundary and select the pilot

At restart, inspect the current monitor catalogue, profile versions, public testkit exports, typed read contracts and the Ragazzo risk tool output. Choose one synthetic Morpho market with a documented oracle configuration, one lender position and a second holding with a colliding display name. Map position identity, wallet visibility, oracle/market basis, borrower eligibility, market liquidity and account withdrawal capacity from producer to operator-visible evidence. Mark each field as available, available by follow-up, or missing.

Agree a small pack schema with separate agent-visible and grader-only artifacts. Pin revisions, normalized units, fixed clock, seed, dependency edges, source observations, visibility by turn, rubric and content hashes. Define compatibility failure behavior for an unsupported version, absent field or unknown route.

**Done when** both repositories can use the same example contract and the reviewer can trace one question to the specific holding, observations, tool read and permissible conclusions. Any evidence gap that changes answerability is visible in the case specification.

### 2. Build the first incident dossier and its control

Start from the Maker liquidation-capacity precedent and the ETH-collateral redemption analogy already documented. Extract mechanisms transferable to a synthetic Morpho market. Pin an incident timeline with sources, event and publication times, venue, units, uncertainty, and the distinction between documented observations and chosen parameters. Choose a background path that both variants share, and a single intervention with observable consequences. Write a second turn that asks what changed. Review the questions in Italian and English for accidental hints.

**Done when** an independent reviewer can reconstruct what the agent could know before and after the divergence, including a plausible condition for holding and a plausible condition for reducing exposure. The author records how to classify an unavailable size-specific quote.

### 3. Deliver a working Morpho generator in FC

Implement the smallest deterministic event schedule that reproduces the worked example. Model borrower debt and collateral, lender claim, market cash, configured oracle updates and executable prices on distinct clocks. Pin chain, units and observation anchors. Use exact quantities and strict fixtures for the protocol reads exercised by the case. Run the real evaluator and evidence service. Export the FC reads and, separately, independent arithmetic and causal expectations.

**Done when** two clean runs produce identical bytes under the same versions and seed, a delayed oracle update changes eligibility at the intended turn, changing only telemetry leaves economic truth unchanged, and an independent check catches an injected decimal or cash-conservation error. State which paths were exercised through adapters and which were supplied as typed fixture responses.

### 4. Take the pair through the real Ragazzo chat path

Register the farming-risk suite in the existing eval CLI. Provision a synthetic owner and FC team in a disposable database. Bind the owner's normal risk tools to the pack-backed FC endpoint. Submit an ordinary structured tag and an untagged follow-up through the chat executor. Isolate time, permissions, research excerpts and trial state. Record tool arguments, evidence after compaction, answer and failures per turn. Keep future events, pair labels and the grading rubric inaccessible to the specialist.

First run a scripted offline transport check. Then, in a separately selected and budgeted run, let the unchanged specialist select its tools. Use the same pack and questions for both paths.

**Done when** the pilot produces a replayable trace and a wrong-wallet join or future disclosure fails an explicit check. A reviewer can distinguish an omitted FC field, a field lost in the adapter, and a field available to the agent that it never requested.

### 5. Calibrate usefulness and take the first baseline

Build reviewed examples for a supported hold, a justified reduction, an unsupported exact percentage, needless abstention and appropriate uncertainty. Score identity, access scope and structured facts deterministically. Grade natural-language grounding, usefulness and uncertainty with a versioned rubric and a calibrated judge. Where the evidence supports several actions, record the reasoning each requires.

Compare judgments with independent human ratings and reserve a separate calibration check set. Record agreement and disagreements per axis. Fix grading failures before using that axis for model comparisons. Capture a baseline of the unchanged specialist before tuning its instructions. Record model and judge versions, cost caps, latency, retries, qualified counts and skipped runs.

**Done when** the operator can inspect each failure alongside the question, evidence and a defensible alternative. The evaluator distinguishes “take a direction, exact sizing is unknown” from “nothing can be concluded.” Identity or scope failures remain visible regardless of the prose score.

### 6. Expand across the monitored pool families

| Case family | Seed and control | Decision to distinguish |
| --- | --- | --- |
| Morpho Blue lender | Deleveraging with delayed settlement versus the same repricing with adequate execution capacity | Borrower eligibility, successful liquidation, recognized loss and lender withdrawal capacity |
| Curve stablecoin LP | Settlement delay or dislocation versus ordinary turnover with similar gross outflow | Relative pricing, supported attribution to one coin, reserve drain and size-specific exit |
| Curve ETH LP or wrapper | Confirmed inventory loss and a downstream pause versus ordinary LP redemptions | Pool-wide loss, wrapper exposure through a verified link, and economic impact on a particular holder |
| Scoped collateral restriction | The same restriction at the custodian or at an unrelated address | Which operation is blocked and which holdings are exposed |
| Morpho vault | Stress in an allocated market or in an unrelated market | Immediate liquidity, NAV, allocation concentration and the quality of withdrawal evidence |
| Cross-cutting controls | Identical economics with lost telemetry, missing quote, revised visibility or a watch-only pool | Appropriate uncertainty, correct ownership and action limited to verified exposure |

Start with six benchmark questions covering name collisions, gross versus net flows, full-size quotes, missing sizing evidence, stale monitors and untagged follow-ups. Reuse worlds across questions. Extend to the twelve paired dimensions in the benchmark design and map each to at least one world and an observable difference. Hold out entire incident variants, review exclusions and keep denominators by family. Use synthetic identities throughout.

**Done when** all three protocol families have an independently reviewed stress/control pair, every claimed comparison has the necessary tool-visible evidence, and deliberate wrong joins, direction errors and inappropriate abstentions are detected. Report unsupported profile or field coverage explicitly.

### 7. Make routine use reproducible

Ship the offline structural suite in CI and an explicit, budgeted model run in the existing CLI. Document clean-checkout generation, offline replay, selection of a case, reproduction of a failed turn and paired comparison between baseline and candidate. Compare the same held-out cases, use three trials for difficult cases and report individual verdict changes alongside per-family counts. Keep infrastructure failures, exhausted budgets and unqualified judge results distinct from agent failures.

For the first release, require all deterministic invariants, entity/scope checks and visibility/temporal checks to pass. Set semantic regression thresholds after reviewing the baseline, with a documented minimum sample size and disagreement handling. Record the agreed thresholds before comparing the next candidate. A new model, policy or incident dossier should receive a new version with provenance, a regenerated pack and a comparable report.

**Done when** a fresh contributor can regenerate a pack, reproduce a failed case and compare two revisions using the runbook. The operator has one reviewed baseline, a failure breakdown by owning layer, and an explicit list of coverage gaps.

## Sequencing and decisions at restart

The critical path is contract → one Morpho pair → real chat trace → calibrated baseline → wider coverage. Once the contract is fixed, the FC generator and Ragazzo fixture transport can progress in parallel against the same sample pack. Research on Curve and vault cases can also proceed independently. Keep a single integration owner for pack compatibility. A useful stopping point is the first end-to-end Morpho pair, where the value of the harness can be judged before funding the larger case bank.

At restart, record the two repository revisions, confirm the deployed profile and per-field coverage, and agree the pilot question and two defensible answers. Select model/provider and spending cap only when a scored run is ready. If a decisive fact is lost between FC and Ragazzo, first preserve the failing trace and assign the fix to the owning layer. Rerun the identical pack after the fix. If the product cannot observe the fact, score the supported partial judgment and track the coverage gap separately.
