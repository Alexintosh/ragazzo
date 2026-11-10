---
name: agent-activity
description: Follow a Rakazo agent run through the typed thread snapshot and live activity events.
---

Use the existing authenticated Rakazo RPC client, not direct database access or UI automation.
See [the activity contract](../../../docs/agent-activity.md) and
[typed thread procedures](../../../packages/contracts/src/rpc.ts).

1. Resolve the operator-selected bot, group or task target in the current space.
   Read `threads/get` using that target. Existing membership/target authorization applies.
2. Read the optional `activity` array and its `runId`/`botId` attribution. Absence
   means an older server; do not fabricate thinking or tool outcomes.
3. Subscribe using `threads/subscribe` with the same target and snapshot cursor.
   Apply the shared `reduceAgentActivity` reducer from `@rakazo/core` in sequence.
   Ignore heartbeats, duplicates and events at or before the snapshot cursor.
4. A reconnect or terminal transition requires another `threads/get` read. This
   recovers persisted activity and current run state. History is bounded; it is
   not a full execution audit. Never replay a tool to recover missing display data.
5. Calls are scoped by run and execution ID. Report Running, Completed, Failed,
   Waiting or Stopped exactly as supplied. Missing completion is not success.
   Public reasoning summaries may be available for Codex and OpenAI Responses;
   other providers can expose only Thinking lifecycle. Never request private
   reasoning, encrypted fields, signatures or raw credential payloads.

This workflow is read-only and needs no apply or CAS operation. It does not
approve, retry, cancel, execute or send messages. Any such action needs its own
operator authorization. Validate the result by rereading the same target and
checking run attribution, terminal state and tool outcomes.
