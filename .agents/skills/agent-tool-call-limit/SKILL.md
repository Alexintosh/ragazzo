---
name: agent-tool-call-limit
description: Inspect or change an operator-owned Pi agent's optional tool-call limit through typed RPC.
---

Use the existing authenticated space RPC client. Read
[the contract and recovery workflow](../../../docs/tool-call-limit.md).

1. Resolve the operator-selected bot with `bots/get({botId})`. Confirm it belongs
   to the current authorized space, is an agent and uses Pi. Do not inspect secrets.
2. Normalize absent `maxToolCallsPerTurn` to null. Null uses the deployment default,
   normally unlimited. A positive integer is the bot's explicit override.
3. A read-only request stops after reporting the current value. For an authorized
   change, validate the reviewed positive integer (maximum 2147483647), or null
   to disable the override. Never infer permission to start a run.
4. Call `bots/update` with only `botId`, the reviewed `maxToolCallsPerTurn`, and
   `expectedMaxToolCallsPerTurn` equal to the value just reviewed. Other bot
   settings and the deployment environment remain untouched.
5. Reread `bots/get` and compare the saved value. If the write response was lost,
   reread first; the desired value may already be saved. On CONFLICT, reread and
   review the new state before retrying. Preserve the operator's requested value.

The counter is shared with Pi nested agents but is process-local and resets when
the run moves to another worker or the worker restarts. A save applies at the next
Pi start/resume. It does not change the token cap, terminate existing work, roll
back effects or supply durable usage accounting. Report offline tests separately
from real-provider/manual acceptance.
