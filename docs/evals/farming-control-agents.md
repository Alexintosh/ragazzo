# Farming Control agent benchmark

Design proposal for the Ragazzo testkit. The first suite evaluates FC Risk. The same runner should later support yield questions for the coordinator, harvest reconciliation for Accounting, and fiscal-evidence questions for Tax.

## What one trial measures

A trial starts with a synthetic portfolio, a named specialist, and an operator question. The agent receives the normal owner permissions, its generated workflow and the structured message that the product would submit. The model chooses its tools. The trial ends with the answer shown to the operator or an explicit failure. The report links the answer to the evidence available at that turn.

Consider two Safe positions with the same pool label. The operator tags the second holding and asks whether to reduce it. A convincing answer based on the first Safe fails identity resolution. If the tools supply the right holding, complete gross and net flows and a position-sized quote, replying “you should investigate the exit route” can pass identity and fail usefulness. A third case supplies no position-sized quote. Recommending a direction while identifying the missing evidence for sizing can earn full credit there.

## Where it fits

| Existing component | Proposed use |
| --- | --- |
| Ragazzo testkit eval CLI and runner | Register a farming-risk suite. Reuse disposable Postgres, trial isolation, model connections, usage measurement and spend caps. |
| FC team provisioning, message blocks, run executor and specialist tool gates | Seed a synthetic owner and provision the actual FC team. Start ordinary private runs. Preserve tags and follow-ups through normal message persistence and Pi model/tool turns. |
| FC typed read APIs and Ragazzo adapter | Serve versioned, synthetic FC HTTP responses on loopback. Exercise the production joins, decimal handling, visibility revisions and compact output. Pin time and fixture state by turn. |
| Existing wire and tool observers | Record calls, arguments, actual returned evidence, omissions and the sequence seen by the model. Keep hidden expectations in the grader. |
| Existing judge, reporting and budget support | Supply FC-specific rubrics, reviewed calibration examples and per-axis grades. Measure inference and grading separately. |

Create the synthetic owner before constructing the owner-bound FC service, then reopen the app on the same disposable database for the trial. Specify the fixture owner and API endpoint explicitly. Disable background routines and delivery. A research capability needs its own fixture transport or an unavailable result because it can read official external sites independently of the FC API. A scripted offline run in CI verifies transport, tags, grants and joins. A scored agent run lets a real model select tools against those same fixtures. A replay supplied with correctly joined evidence is a diagnostic control for a failed scored run.

## Initial case bank

Start with twelve paired scenarios. Within each pair, hold the question and unrelated evidence constant and vary one fact. Include multi-turn cases in Italian and English, with natural questions that contain no hints about the expected tool or recommendation.

| Pair | What changes | What should change in the answer |
| --- | --- | --- |
| Identity | Two identically named pools, different chains or Safes | Facts follow the selected ID. A genuinely ambiguous name prompts a focused clarification. |
| Attribution | Proven position link becomes an uncertain link | Pool findings remain valid. The holding mark can no longer establish capital at risk in that pool. |
| Wallet visibility | A holding becomes hidden between reads | Withhold its evidence and avoid attributing a value to it after the scope change. |
| Signal | Gross outflow stays high while net flow switches from positive to sharply negative | Distinguish turnover from reserve pressure. Explain the resulting judgment. |
| Quote | A full-size quote becomes a small probe | Confidence in whole-position exit cost changes, even if the strategic direction remains defensible. |
| Time | Today's reserve warning becomes a dated warning followed by a warming monitor | Explain the last observation and today's uncertainty. |
| Coverage | The same numeric flow has a complete window or partial event coverage | Qualify what the observation can establish about the full period. |
| Portfolio exposure | The same deteriorating holding accounts for 3% or 35% of the portfolio | Weigh concentration explicitly. |
| Severity | Comparable reserves stabilize or keep declining alongside a confirmed depeg | Reassess the case for holding, trimming or exiting. |
| Answerability | The requested exact reduction has an explicit target and matching quote, or lacks them | Use justified sizing when possible. Otherwise give the supported direction and identify the missing input. |
| Conversation | A follow-up refers to the prior holding or explicitly switches to another | Reuse the correct identity or resolve the new one. Reread evidence after a dated state change. |
| Watch-only pool | An explicitly watch-only monitor gains a confirmed holding | Report pool risk in both cases. Recommend a portfolio action only for verified exposure. |

Author each case with an initial world, allowed reads, questions and tags per turn, state changes, relevant evidence IDs and units, permissible conclusions, and claims contradicted by the evidence. Keep synthetic names neutral. Hold out entire scenario variants when tuning the workflow. Maintain separate questions for detailed reports and short decision requests.

## Scoring and diagnosis

1. **Deterministic checks** cover the actual entity and monitor IDs, visibility revision, returns consumed by the model, tool grants, and side effects. Accept equivalent tool paths that deliver the required evidence. Wrong-wallet attribution, hidden-data disclosure or an unauthorized action fails the trial.
2. **Response quality** is graded on factual grounding, decision usefulness, and handling of uncertainty. Score each axis from 0 to 2 with examples of inadequate, partial and satisfactory answers. Factual checks include units, gross versus net, observation time, and which asset lost its peg. Usefulness requires a supported stance and the condition that would change it. Allow multiple defensible recommendations. Uncertainty is appropriate when a missing fact affects the decision; unnecessary abstention and unsupported certainty are separate errors.
3. **Calibration** uses a versioned, opt-in semantic judge checked against human-reviewed examples of good, fluent-but-wrong, needlessly evasive and overconfident answers. Give the judge the question, the evidence actually delivered to the agent, the hidden rubric and the answer. Independently compare synthetic source truth with delivered evidence to identify adapter defects. Blind model/version identity in comparative review, rotate answer order and record ties. A failed calibration or judge error leaves the semantic grade unqualified.
4. **Failure report** shows the turn, the operator-visible answer, the first failed check, expected and observed evidence, and an example of how an operator could use a better answer. If the join is missing in the adapter result, fix the integration. If the model skipped an available read, inspect selection and tool descriptions. If the right evidence reached the model, inspect its reasoning in the answer and the workflow instructions.

For each version record the repository revision, workflow, case pack, model settings, judge, trial count, latency, tool calls, and generation and judging costs. Report metrics by scenario family with denominators, including wrong-entity rate, unnecessary abstentions on answerable cases, unsupported claims on insufficient-evidence cases, and useful grounded answers. Compare candidate and baseline on the same cases. Show planned, attempted, completed and judge-qualified counts. Display provider failures and budget skips separately. Show individual verdict changes. Repeat challenging cases three times and report how many passed all three runs. An offline structural pass or a skipped provider run contributes no semantic pass.

## First milestone

Start with six cases covering a name collision, gross versus net flow, a full-size quote, missing sizing evidence, a stale monitor and an untagged follow-up. Before expanding to all twelve pairs, demonstrate that the suite catches a deliberately broken position-to-monitor join and that a generic abstaining answer scores poorly on answerable cases. Run one baseline against the unchanged specialist and review disagreements with the operator. Publish the initial rubric after that review.

The proposed interface extends `pnpm test:evals` with `--suite farming-risk`. That suite is a planned addition. The previous three scripted-evidence conversations provide seed cases; end-to-end reliability requires fresh tool selection and repeated trials.

## Methodological references

ToolBench contributes single-tool and multi-tool task construction. StableToolBench illustrates how a stable API environment makes repeated evaluations comparable. [ToolBench paper](https://arxiv.org/abs/2307.16789) · [StableToolBench paper](https://arxiv.org/abs/2403.07714)

τ-bench contributes multi-turn domain interaction and repeated-run reliability. BFCL contributes checks on function choice and arguments. For a read-only Risk specialist, the observable outcome is a grounded decision under the correct visibility scope. [τ-bench paper](https://arxiv.org/abs/2406.12045) · [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)
