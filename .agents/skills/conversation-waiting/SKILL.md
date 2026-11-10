---
name: conversation-waiting
description: Inspect why a Rakazo conversation or workflow is waiting through typed RPC.
---

Use [the read and recovery contract](../../../docs/conversation-waiting.md).

1. Resolve the operator-selected accessible bot, group or task in the current Space.
   Read `threads/queue` with that target, or `workflows/run({runId})` for a workflow.
2. Treat `waitingDetail` as read-time evidence for its exact run. When absent or
   generic, report an unresolved wait rather than inventing an actionable request.
3. Read `threads/get` and locate the referenced message before any authorized action.
   Inspection is read-only; it does not grant approval, submit a secret, answer the
   user or take control of a computer. Use only the existing typed workflow for an
   action the operator has authorized. Never place credentials in reports.
4. After a write or ambiguous response, reread the same thread and queue. Do not
   replay completed approvals or stale questions. Rejections can mean another
   device has already acted; report the current state and preserve any failure.
