# Q1 — Waiting detail projection

Status: implementation ready for integration; **not fully PASS** until the two
integrator patches below are applied and verified. Date: 2026-11-09.
Q2 clients are unchanged. No runtime, provider, operator data, configuration,
database, staging or commit operations were performed by this agent.

## Architecture fit recorded before coding

| Seam | Existing primitive and consumers | Q1 reuse / mismatch |
| --- | --- | --- |
| Domain/contracts | [ThreadQueueSchema](../packages/contracts/src/thread-queue.ts), [WorkflowNodeStateSchema](../packages/contracts/src/workflow.ts); [RPC schemas](../packages/contracts/src/rpc.ts) | Optional shared `waitingDetail`; legacy enums and required fields unchanged. |
| Pending requests | [findPendingAsk / commitAnswerRunInput](../packages/db/src/events.ts), [card classifiers](../packages/core/src/action-approval.ts), [takeover card state](../packages/core/src/thread-message-updates.ts) | Reuse same-run bot messages, current pending card, intended approval effect, native approval and secret classifications. No new request store. |
| Repository/application projection | [queueState](../apps/api/src/thread-queue.ts), [workflow repositories](../packages/db/src/workflows.ts), [pure decision](../packages/db/src/waiting-detail.ts) | Owned repository reader supplies one pure classification function. Read-time hints never become persisted workflow state. |
| API/authorization | [queue route](../apps/api/src/routes/threads.ts), [workflow routes](../apps/api/src/routes/workflows.ts), existing answer/computer endpoints | Existing typed outputs carry the addition automatically. Workflow list's synchronous mapper needs the integrator patch below. Existing action validation remains authoritative. |
| Shared exports | [contracts index](../packages/contracts/src/index.ts), [DB index](../packages/db/src/index.ts) | Existing export stars already expose the changed contracts and functions declared in owned `workflows.ts`. No package index changes or patch required. |
| UI/agent | [web queue](../apps/web/src/pages/shell/thread-queue.tsx), [web workflows](../apps/web/src/pages/Workflows.tsx), [mobile queue](../apps/mobile/app/conversation-work.tsx), [mobile workflows](../apps/mobile/app/workflows.tsx) | Q2 only. No UI edits in Q1. No separate queue/workflow agent tool consumer was found in adapter source searches; the typed RPC boundary is available for follow-on consumption. |
| Runtime/worker | [workflow reconciler consumer](../packages/adapters/src/workflows.ts), existing queue mutation/conversation-task consumers | Worker transitions, queue ordering/revisions, cancellation/recovery and composition roots unchanged. |
| Persistence/migrations/accounting | Existing Prisma run/message/effect/computer models | Read existing evidence only; no schema, migration, new persistence or accounting semantics. |
| Providers/Settings/FC | Existing integrations and settings | No changes required. No protocol/position adapters involved. |
| Fixtures | [Vitest config](../vitest.config.ts), [offline setup](../packages/testkit/src/pin-test-env.ts), existing queue/workflow fixtures | Focused pure and mocked-reader tests; explicitly unset live-provider/database/logging verification switches. No integration server. |

Source resolved the ownership questions: `messageId` is the existing answer-card
reference; approvals use an intended effect from that same run unless native;
takeover requests use the pending computer card. A historical or unsupported
request has generic detail and no action. No unresolved persistence decision.

## Changed paths owned by Q1

- `apps/api/src/thread-queue.ts`
- `packages/contracts/src/thread-queue.ts`
- `packages/contracts/src/workflow.ts`
- `packages/contracts/src/waiting-detail.test.ts` (new)
- `packages/db/src/workflows.ts`
- `packages/db/src/waiting-detail.ts` (new pure decision)
- `packages/db/src/waiting-detail.test.ts` (new)
- `packages/db/src/workflow-waiting-detail.test.ts` (new)
- `docs/state-machine-reliability-q1.md` (this report)

Concurrent changes outside these paths belong to other owners. In particular,
adapter Intelligence changes and `infra/cloudflare/` were not edited. The eight
protected FC runtime/Supervisor dirty files were not edited. Both checkouts
remain on `codex/state-machine-reliability`. Observed Ragazzo HEAD remains
`b8ae31dc535893ed70ecbf1c77a6d066acddedbb`; FC HEAD advanced concurrently to
`a4e811535c600a14d96afdded5c526fd2fad13a1`. Both indexes were empty on inspection.

## Client contract and examples

Both `ThreadQueue.waitingDetail` and `WorkflowNodeState.waitingDetail` are
optional. The discriminated union is:

| reason | required references | action |
| --- | --- | --- |
| `waiting` | `runId` | absent |
| `question` | `runId`, `messageId` | `answer` |
| `approval` | `runId`, `messageId` | `review_approval` |
| `secret` | `runId`, `messageId` | `provide_secret` |
| `takeover` | `runId`, `messageId` | optional `takeover` |

These are navigation/action hints, not new RPC procedures or authorization
tokens. Answer, approval and secret hints open the existing message card and
use `threads.answer` with its existing conversation target, `runId`, `messageId`
and card-specific input. Approval choices must come from that card; the hint
does not approve anything. A secret hint carries no text, credential metadata,
answer, effect request/result or secret value. Takeover opens the existing
computer flow for the bot from the conversation/workflow graph. The server
offers its action only for an owned running computer tied to this waiting run
through control or the bot's execution lease. A takeover reason can therefore
exist without an available action.

Before, an ordinary question produced only:

```json
{"revision":1,"entries":[],"canSteer":false,"waitingReason":"approval"}
```

After, the same legacy fields remain and the server adds:

```json
{"waitingDetail":{"reason":"question","runId":"synthetic-run-question","messageId":"synthetic-request-question","action":"answer"}}
```

For a workflow node, `status: "waiting_approval"` remains unchanged while
`waitingDetail.reason` can be `question`, `approval`, `secret` or `takeover`.
The reader also handles a node still marked `queued`/`running` whose linked run
already waits: scheduling status is independent of the run's request reason.
A waiting historical node with no usable run/card evidence gets
`{"reason":"waiting","runId":"run-a"}`. A terminal run cannot produce an
action, and terminal nodes/workflows are never enriched. A stale waiting node
whose linked run has already finished retains only the generic node fallback.

Messages are inspected newest-first within the latest 50 bot messages of the
same run and thread, matching the existing pending-ask reader. Answered cards,
other-run cards and completed/other-run approval effects cannot supply an
action. Unsupported approval shapes degrade to generic waiting. Detail is
stripped from saved workflow nodes before reconciliation/recovery persistence.

## Integrator patches (not applied by Q1)

### Workflow list route

The singular `workflows.run` plus start/cancel/recover final rereads already use
the enriched repository reader. `workflows.runs` still uses its synchronous
legacy row mapper and therefore supplies generic waiting. Apply this patch in
the integrator-owned common route before claiming consistent list detail:

```diff
--- a/apps/api/src/routes/workflows.ts
+++ b/apps/api/src/routes/workflows.ts
@@ -6,12 +6,12 @@
   attachWorkflowRecoveryInTransaction,
   getWorkflow,
   getWorkflowRun,
+  readWorkflowRunView,
   reconcileWorkflow,
   requestWorkflowCancellation,
   saveWorkflow,
   startWorkflow,
   WorkflowConflictError,
-  workflowRunView,
   workflowView,
 } from "@rakazo/db";
 import { getLogger } from "@rakazo/logging";
@@ -77,7 +77,7 @@
       runs: authed.workflows.runs.handler(async ({ context, input }) => {
         await getWorkflow(deps.prisma, context.actor, input.workflowId);
         return {
-          runs: (
+          runs: await Promise.all((
             await deps.prisma.workflowRun.findMany({
               where: {
                 workflowId: input.workflowId,
@@ -87,7 +87,7 @@
               orderBy: [{ createdAt: "desc" }, { id: "desc" }],
               take: 50,
             })
-          ).map(workflowRunView),
+          ).map((row) => readWorkflowRunView(deps.prisma, context.actor, row))),
         };
       }),
       run: authed.workflows.run.handler(({ context, input }) =>
```

### Existing queue unit fixture

The focused pre-existing queue test fails in all four runtime cases because
its mocked transaction has no `message` or `externalEffect` reader. This is a
fixture dependency introduced by the new read, not a live database failure.
The existing test file was outside the explicit assigned edit list; apply:

```diff
--- a/apps/api/src/thread-queue.test.ts
+++ b/apps/api/src/thread-queue.test.ts
@@ -10,6 +10,8 @@
     async (runtimeKind) => {
       const tx = {
         thread: { findFirst: vi.fn(async () => ({ nextEventSeq: 5 })) },
+        message: { findMany: vi.fn(async () => []) },
+        externalEffect: { findMany: vi.fn(async () => []) },
         steeringMessage: {
           findMany: vi.fn(async () => [
             {
@@ -22,7 +24,9 @@
           ]),
         },
         run: {
-          findFirst: vi.fn(async () => ({ id: "active", status: "running", trigger: "user" })),
+          findFirst: vi.fn(async () => ({
+            id: "active", threadId: "thread", botId: "bot", status: "running", trigger: "user",
+          })),
         },
         event: { findFirst: vi.fn(async () => null) },
       };
@@ -38,6 +42,8 @@
       expect(result.snapshot).toMatchObject({ canSteer, entries: [{ canSteer }] });
       tx.run.findFirst.mockResolvedValue({
         id: "active",
+        threadId: "thread",
+        botId: "bot",
         status: "waiting_input",
         trigger: "user",
       });
```

Format both patched files and rerun the focused queue file. Both patches passed
`git apply --check` against current sources without being applied. Their runtime
behavior remains unverified; Q1 does not claim those four tests passed.

## Q2 handoff

Use detail first, with legacy fallback when absent (new client/old server).
Generic detail must show generic waiting without a request action. Old clients
continue parsing the unchanged enums and ignore the optional property.

Update `apps/web/src/pages/shell/thread-queue.tsx`, its hook/tests,
`apps/web/src/pages/Workflows.tsx`, `apps/mobile/app/conversation-work.tsx`,
`apps/mobile/lib/conversation-work.ts` and `apps/mobile/app/workflows.tsx` with
the existing localization/card/navigation primitives. Electron hosts the web
UI and requires no separate orchestration. Preserve existing queue revision
handling in `use-thread-queue.ts` and `latestQueue`; equal revisions may carry
new live detail. Preserve workflow revision/CAS and recovery preconditions.
Use the workflow graph's bot and node task for its existing conversation
target. Do not turn the hint into a new effect or automatic answer.

Reread on reconnect, after another-device answers, and after a rejected action.
`threads.answer` already returns CONFLICT when a prompt is no longer pending.
Do not retain a button after refreshed detail loses its action. The read is a
snapshot; it cannot authorize an action after another device changes state.
UI/action handling, real reconnect and a full client version matrix remain Q2.

## Verification actually executed

From repository root, installed binaries only; no install or runtime start:

```sh
node --version
node_modules/.bin/tsc --noEmit -p packages/contracts/tsconfig.json
node_modules/.bin/tsc --noEmit -p packages/db/tsconfig.json
node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.json
env -u VERIFY_PROVIDERS -u VERIFY_DATABASE -u VERIFY_LOGGING node_modules/.bin/vitest run packages/db/src/waiting-detail.test.ts packages/db/src/workflow-waiting-detail.test.ts packages/contracts/src/waiting-detail.test.ts packages/contracts/src/workflow.test.ts
env -u VERIFY_PROVIDERS -u VERIFY_DATABASE -u VERIFY_LOGGING node_modules/.bin/vitest run apps/api/src/thread-queue.test.ts
node_modules/.bin/biome check packages/contracts/src/thread-queue.ts packages/contracts/src/workflow.ts packages/contracts/src/waiting-detail.test.ts packages/db/src/workflows.ts packages/db/src/waiting-detail.ts packages/db/src/waiting-detail.test.ts packages/db/src/workflow-waiting-detail.test.ts apps/api/src/thread-queue.ts
git diff --check
```

Typechecks passed (contracts, DB, API). Four focused files passed **61 tests**.
The separate existing queue test failed **4 tests** with missing mocked
`message.findMany`; see patch above. Initial focused runs had 30, 52 and 58
passing cases as fixtures were added. Initial formatter checks failed and were
fixed using `biome check --write` on only the owned paths; final check passed.
`pnpm --filter @rakazo/contracts check` and `pnpm --filter @rakazo/db check`
could not run (`pnpm` unavailable); the installed local `tsc` commands above
performed those same package checks. Node version observed: v22.23.1.

Affected-module bundle build passed using the following command. It writes no
files and is not a claim that the full production distribution was built:

```sh
node --input-type=module -e 'import { build } from "esbuild"; await build({ entryPoints: ["apps/api/src/thread-queue.ts", "packages/db/src/workflows.ts", "packages/contracts/src/thread-queue.ts", "packages/contracts/src/workflow.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", write: false, outdir: "/tmp/rakazo-q1-memory-build", logLevel: "warning" }); console.log("Q1 affected-module bundles passed in memory; no output files written.");'
```

Source/Git inspection used `rg`, `cat`, `sed`, `git status --short`,
`git branch --show-current`, `git rev-parse HEAD`, `git diff`,
`git diff --numstat`, `git diff --cached --name-only` and `git apply --check -`
(each documented patch supplied through stdin). No FC tests, monorepo
suite, Postgres integration, E2E, Electron, live LLM/provider, production build
installation or operator runtime smoke was executed.

## Acceptance and rollback

| Acceptance | Evidence/status |
| --- | --- |
| Question, choice, approval, native approval, secret, takeover | PASS: pure decision fixtures; output contains only references/reason/action. |
| Busy/queued/leased/running and terminal runs | PASS: no detail invented by decision function. Queue selection/order/steering logic unchanged; queue fixture file currently FAIL pending integrator mock repair. |
| Historical missing/invalid/unsupported detail | PASS: generic waiting and no action. |
| Other-run/answered request or stale effect | PASS: cannot supply an action. |
| Two workflow waits and node/run state separation | PASS: mocked repository fixtures, including stale queued/running node status. |
| Another-device answer | PASS for deterministic reread fixture; live device interaction NOT TESTED. |
| Caller isolation / unavailable takeover | PASS for scoped-query assertions and synthetic reader cases; no live authorization exercise. |
| Old schema/new payload and new schema/old payload | PASS: schema fixtures. Real old/new deployed clients NOT TESTED. |
| Detail on all workflow API surfaces | INTEGRATION REQUIRED: common list-router patch above. |
| Existing focused queue unit file | FAIL: four incomplete mocks; exact repair above, not yet applied. |
| Runtime/UI/agent usability/reconnect | NOT TESTED; Q2 and operator activation gates remain. |

Rollback removes the optional projections/contracts and the integrator route
patch, or lets clients use legacy fields. No durable migration or worker
rollback is required, and no effect is created or replayed by reading detail.

## Integrator follow-up

The common workflow-list route now uses `readWorkflowRunView`. The existing
queue mock now supplies the scoped message/effect readers and run/thread/bot
identity. Both files were formatted. The five focused files, including the
previously failing queue cases, pass: 65 tests. The API typecheck passed after
these patches. Independent review and Q2 client verification remain pending.

Independent review approved Q1 and repeated 65 tests. The integrator resolved
both resource follow-ups: intended effects are restricted to IDs referenced by
the bounded same-run message sample, takeover lease reads select the exact run,
and workflow list enrichment processes one graph at a time per request. No
global execution queue was added. A focused approval-reference reader case was
added. The integrated Q1/Q2/answer checks pass 130 offline tests across 13 files;
this count is one combined run and is not additive to earlier reruns.
