# Conversation and workflow waiting requests

The existing authenticated `threads/queue` and `workflows/run` RPC reads expose
optional `waitingDetail` for the current run. Its reason distinguishes a question,
approval, credential request, computer takeover, or an unresolved generic wait.
Actionable details contain the message ID; they never include secret values.
Old servers may omit the field. An absent or generic detail does not authorize an
answer, approval, secret submission or takeover.

Read the relevant thread with `threads/get` before acting. Preserve the exact
run/message identity and use the existing authorized answer or computer-control
flow. The workflow scheduling status is separate from its linked run's request.
No new durable state, migration, authorization rule or scheduler is introduced.
The existing contract, repository read projection and shared core presentation
serve API, web/Electron and native mobile consumers.

After an action, reread the thread and queue even if the server rejects it: another
device may already have answered. Do not replay approvals or secret submissions
following an ambiguous result. Web reconciles equal-revision reads by request
order, rereads on focus/reconnection, and discards results for an old conversation.

Offline contract, repository, API and client tests cover request correlation,
unsupported/obsolete cards and stale reads. They do not establish live-provider,
manual mobile or real database concurrency acceptance.
