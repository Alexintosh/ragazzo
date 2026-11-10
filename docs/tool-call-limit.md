# Pi tool-call limit

In an agent's **Advanced** settings, open **Execution limits** below Model.
**Limit tool calls** starts off. Enable it and enter a positive whole number in
**Maximum tool calls**, then Save. The proposed enabled value is 50; it is not
applied until saved. Web and Electron share the same form; mobile has matching
native controls. This setting is available for Pi agents. It does not apply to native Codex/Claude/ACP or roleplay.

Disabling the override uses the deployment default: unlimited when
`MAX_TOOL_CALLS_PER_TURN` is unset or zero. Existing deployments that configured
that environment fuse retain it. An explicit bot override takes precedence.
The override is retained when duplicating a bot. It does not change token budgets.

The existing Pi counter admits at most the configured number of tool executions,
then refuses further calls, drains in-flight calls and emits the existing stopped
message. Pi's nested agents share the same counter. Calls already made are not
rolled back. The setting is read when work starts or resumes, not hot-applied to
an already running turn. The counter is process-local, including its pause/resume
cache; restarting or moving the run to another worker resets it. This is an
experimental execution fuse, not durable usage accounting or a security boundary.

## Implementation map

| Seam | Existing primitive and change |
| --- | --- |
| Contract | Optional nullable `Bot.maxToolCallsPerTurn` and `bots/update` patch; positive integer, null selects deployment default. |
| Persistence | Nullable integer on existing Bot row with an additive positive-value constraint; existing bots stay null. |
| Application/API | Existing actor-scoped bots get/update/duplicate and `commitBotUpdate`; comparison with the old value prevents stale writes. The bot's self-settings tool cannot change this operator control. |
| Runtime | Existing executor passes the override in `AgentRunRequest`; `toolCallBudgetFor` reuses the existing Pi fuse and nested-agent shared budget. No new scheduler, service or runtime instance. |
| UI | Existing Advanced settings, Save/dirty handling and native mobile settings; no separate Settings store. |
| Fixtures | Existing offline Pi dispatch fake, settings form fixture, contract validation and bot-update transaction mock. |

## Typed API workflow

Use authenticated RPC in the operator's selected space. `bots/get({botId})`
returns the optional `maxToolCallsPerTurn`; normalize absent to null for old
clients. Only an accessible, unarchived Pi agent supports a positive override.

After reviewing the bot and desired limit, call:

```json
{"botId":"fixture-bot","maxToolCallsPerTurn":20,"expectedMaxToolCallsPerTurn":null}
```

through `bots/update`. To disable a saved value of 20, send:

```json
{"botId":"fixture-bot","maxToolCallsPerTurn":null,"expectedMaxToolCallsPerTurn":20}
```

Omit unrelated fields. The update is atomic; repeat the same read/compare/write
workflow after an ambiguous response. A stale comparison returns CONFLICT, so
reread and review before retrying. Identical state is already the desired result.
After every write, reread `bots/get` and check the saved value. Saving does not
start, stop or send input to an agent. A separate authorized manual run is needed
to verify behavior with a real provider. No direct database access is required.

No CLI is needed for this single-resource update. Migration deployment and runtime
activation use the existing local stack workflow.
