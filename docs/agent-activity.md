# Agent activity

Use the **Agent activity** icon beside the attachment control to show or hide the
live panel. It starts hidden. Web and Electron use the same panel; mobile
conversations and task conversations use a native disclosure. Hiding the panel
does not stop streaming or agent execution. It is independent of the older
Show tool activity preference.

Calls are matched by run and execution ID. Running, Completed, Failed, Waiting and
Stopped reflect actual tool completion events. Ending a run never turns an unfinished
call into a success. Public Codex and OpenAI Responses reasoning summaries stream into the panel.
Other Pi providers expose Thinking lifecycle only. No hidden reasoning, signatures, raw tool arguments,
raw results, credentials or attachment bytes are added to the activity contract.
Tool outcomes, durations and sanitized errors are available. Unsupported providers
show only the activity they report, without invented reasoning.

## Implementation map

| Seam | Existing owner and extension |
| --- | --- |
| Domain | Shared contracts add optional `ThreadSnapshot.activity` and public summary validation. |
| Persistence | Existing Event rows and fenced append; no table or migration. |
| Application | Shared core reducer projects the same events for API, web and mobile. |
| Runtime adapters | Existing Codex host broker maps public summary and native tool lifecycle; Pi observes only the public provider summary channel; generic thinking stays boolean-only. |
| API | Authorized `threads/get` includes bounded activity; existing thread event stream carries updates. No new authentication or transport. |
| UI/Settings | Conversation disclosure on web/Electron and mobile. No Settings changes. |
| Composition | Existing run consumer and broker; no new service, process or provider configuration. |
| Tests | Offline reducer, snapshot-reader, summary-redaction, broker and UI fixtures. No live provider calls required. |

## Agent/API contract

Use the normal authenticated `threads/get` RPC with an accessible bot, group or task
target, then the existing thread subscription. `activity` is an optional array for
rolling client/server upgrades. The initial read covers active runs plus up to eight recent runs and
400 events, retaining the last 160 projected entries; it is a bounded recent view,
not a complete audit export. Group entries retain bot and run attribution.
A reconnect rereads the snapshot. Match tool calls by run ID and execution ID; apply
events by sequence, ignore duplicates, and clear activity on thread clearing.

The flow is read-only. It does not authorize or retry tools. Public summaries use the
run's existing streaming secret redactor and lease/fence checks, are limited to 16 KiB
per summary, and are throttled. Summaries persist in the existing Event log. Existing
transient thinking/progress markers retain their cleanup policy, so completed history
can omit those ephemeral phases. Read `threads/get` again after completion to confirm
outcomes; absent completion means stopped/unknown, never success.

No unresolved ownership or persistence questions require a separate subsystem.
