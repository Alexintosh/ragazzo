# Conversation queue

During active work in a bot or task conversation, **Queue** defers a text request until the current work finishes. A pending approval also holds queued requests. Existing **Send** behavior is unchanged.

Expand **Queued** above the composer to inspect the waiting reason and responsible bot. Requests that have not been acquired by the runtime can be edited, moved up or down, or cancelled. Editing a queue entry preserves the ordinary composer draft. A conflicting edit leaves the local text available for review and an explicit retry.

**Steer** offers a queued request to the current running conversational turn. Pi consumes it at a safe boundary; Codex submits it through its acknowledged native steering operation. Queued requests stay deferred until a later turn unless explicitly steered. A batch of queued requests is delivered in the chosen order, within the existing execution model. Use **Start as task** to atomically withdraw an unclaimed entry and start it in a separate conversation. Existing bot/computer leases still serialize conflicting work.

The server owns queue state. Mutations serialize with claims under the thread lock and require the current revision. Once a request has been acquired, it cannot be edited or cancelled individually. **Stop** continues to stop the conversation's active work and cancel its pending input.

Cancelled input remains recorded for the application but is excluded from the agent's prompt, history tools, reply context and future summaries. Pending input is also excluded until acquired. Compaction waits while relevant input remains editable, and advances over cancelled entries without retaining their instructions.

Native Codex saves its exact initial input before dispatch. Recovery reuses that input; it cannot silently acquire newly queued requests into an already submitted turn. An unanswered approval checkpoint replays the approval request instead of approving or rejecting implicitly.

The queue supports text requests in direct, task and group conversations. In a group, **Queue for** requires an explicit member; each member has its own queue controls. Pending or cancelled group input is hidden from every member runtime until acquired. Attachments still use the ordinary Send workflow. Stopped-task recovery and reassignment are described in [Task conversations](conversation-tasks.md). The full-screen computer view provides **Conversation** to return to the same chat and draft; host graphical capabilities are unchanged.

Deploy the additive queue migration before updating API and worker. Upgrade both application processes before exposing queue controls: older workers do not understand deferred delivery or cancellation tombstones.
