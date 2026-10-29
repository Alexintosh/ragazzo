# Experimental roleplay bots

This page describes the internal roleplay engine. The optional [Eros conversation engine](./conversation-engines.md) has its own service, character configuration and lifecycle; its bots do not use the Docker computer or local continuity pipeline described below.

Roleplay is a dedicated bot type, separate from operational agents. In **New bot**, enable **RP** beside the name and import a character JSON. An original example is available in `examples/roleplay/lighthouse-keeper.json`.

Supported imports: plain character objects and Character Card v2/v3 JSON, up to 1 MB. The importer reads character description, personality, scenario, example dialogue, first greeting, narrative directions and lorebook entries. Plain cards may specify `conversationStyle: "narrative" | "chat"`; Character Card v2/v3 imports also support `data.extensions.rakazo.conversation_style` with those values. Older cards keep narrative behavior. Narrative follows the card’s direction; chat writes the character’s messages and may send up to three bubbles separated by blank lines. `examples/roleplay/sara.json` opts into chat. Literal primary/secondary keys, case sensitivity, constant entries, ordering, before/after-character placement, scan depth and a bounded lore budget are supported. `{{char}}` and `{{user}}` expand to the character name and `Player`.

Scripts, executable extensions, regex transforms, recursive lore scanning, assets and advanced rendering are not executed. Import warnings identify recognized unsupported features. This is a text-focused compatibility subset, not a complete RisuAI runtime.

## Execution and story state

- The type is immutable. Roleplay uses the internal model transport and a dedicated Docker computer; it cannot switch to Codex, ACP, Claude Code, host execution or a shared computer.
- Model requests run in the application worker, as with the internal Pi path. A real Docker computer is provisioned and verified. Roleplay exposes only conversation scheduling tools. Filesystem, browser, plugins and other operational tools remain unavailable.
- Model/provider selection uses the existing connection settings. No special model account is required.
- Character configuration is separate from story state. Only the current conversation's narrative messages, bounded summary and continuity snapshot enter the roleplay context. Agent instructions, global memories, skills, plugins and operational tools are not loaded.
- Continuity records the established scene, descriptive relationship, shared details, open threads and relevant callbacks. A separate bounded, no-tools memory request updates it after a reply; it adds model usage and latency, with a 60-second extraction deadline to accommodate slower local models. Text-only completions can stream first; when scheduling tools are available, dialogue is withheld until the final completion so a pre-tool promise is not shown as confirmed. Final persistence waits for extraction or its deadline. Invalid or failed extraction preserves the prior snapshot and the reply. The snapshot and reply save together, and thread, bot and history-generation checks prevent reuse across stories. Proposed plans remain unresolved until the conversation establishes agreement or completion.
- Character cards and story state participate in the existing content encryption. Clearing a conversation clears its narrative state and restores the character's first greeting. Duplicating the bot starts a separate story.
- The first version supports individual stories. Groups, operational handoffs, watch and integration triggers, messaging integrations, file attachments and live calls are unavailable. Speaking a reply aloud remains available.
- Web/Electron share the import UI. Native mobile can read and converse with an imported character; creation directs the user to the web import flow.

## Time, relationship state and spontaneous contact

Chat requests include current time, the known user timezone and the last interaction time. Transcript timestamps stay attached to their original messages: “tomorrow” is grounded in the message that introduced it. If the timestamp or timezone is unknown, relative dates stay uncertain. Continuity can retain up to twelve dated events with source-message provenance and planned, cancelled or resolved status. Newer corrections supersede earlier plans. A date passing never proves an event happened. Narrative fiction time remains separate from wall-clock time; returning to a story does not automatically advance its scene.

Continuity retains its ordinary relationship description and can also record `relationshipState` with integer `warmth`, `intimacy` and `love` values from 0 to 100. These describe the fictional character, never the human user's feelings or psychology. Legacy stories start at warmth 10, intimacy 0 and love 0. Model updates can move each value by at most five in either direction per actual user turn, only with conversational evidence. Spontaneous turns and elapsed time do not increase them. The conversation's relationship debug controls can explicitly set these values for testing; manual edits use the full 0–100 range and remain scoped to that story and history generation.

Saved values persist in PostgreSQL across restarts. Dialogue instructions interpret warmth as friendliness and care, intimacy as emotional openness, and love as affection. Each dimension varies independently while preserving the character's personality and the player's boundaries; high values do not establish reciprocal feelings or invent shared events. This compact guidance remains in chat, narrative, scheduled and spontaneous requests even when optional continuity details must be trimmed for a smaller model. It guides generation rather than guaranteeing particular wording. Continuity updates are validated after merging the scores, so an oversized extraction cannot replace valid saved state with a snapshot that would reset on reload.

Spontaneous contact is an explicit, per-character chat setting; missing settings mean off. Importing any card, including a plain Rakazo-shaped object, never enables it. The frequency setting caps sends within a rolling UTC 24 hours: gentle permits one, balanced two and frequent three. Minimum inactivity is respectively 24, 12 and 6 hours. Warmth of at least 40 plus at least four actual reciprocal user replies may ease inactivity to 18, 8 and 4 hours; this never raises the chosen cap. Seeded greetings, imported examples and generated text do not count as user engagement. Rate accounting covers the owner’s bots across spaces, so adding more characters does not multiply contact or model-check frequency; conversation content stays scoped to its story.

Contact requires an actual user-started conversation and a valid known user timezone. Default contact hours are 09:00–21:00 locally. Allowing late-night contact extends the window to 01:00; 01:00–09:00 always stays quiet. One unanswered spontaneous contact stops further contact until the user replies. Generation attempts, including skips and failures, also have rolling daily caps and cooldowns, so a skipped decision does not cause repeated model checks. Disabled or archived bots and cleared, edited or superseded stories are fenced by backend admission and finalization.

Each optional generation returns a structured send-or-skip decision. A send contains one to three plain text bubbles grounded in the existing conversation. Skipping is expected when there is no suitable reason to contact the user. There are no proactive tools, attachments, fabricated photos or external activity. Current media support remains text plus the existing read-aloud feature; image, video, audio attachment generation and autonomous external browsing are deferred.

Settings, story state, timestamps and already-created tasks/runs are durable in the database. After a worker restart, the initiative scanner recalculates eligibility from those records and the general job reconciler recovers queued or expired-lease runs. No contact is sent while the worker is offline, and current quiet hours, preferences and newer messages are checked again before delivery. Scheduled commitments use the existing routines system separately from spontaneous contact. A character can call `schedule_create` with `delayMinutes: 45` (or an absolute time), then confirm the saved schedule in natural dialogue. Listing, updating and cancelling schedules use the same routines and scope them to this owner, bot and direct conversation. Timer schedules can also be managed by the existing routines API; operational watches and external triggers remain unavailable for RP. The runtime does not infer schedules by parsing promises in prose: success requires a successful tool result. A model without tool-call support, or a context window too small to fit the scheduling tools alongside mandatory character context, cannot create a timer that turn.

The existing `@once` routine, durable wakeup job and job reconciler handle timing and restart recovery. A due routine uses the saved prompt and current RP history without inserting a fake user message or increasing relationship scores as if the user replied. Scheduled commitments follow their saved time, independently of the optional spontaneous inactivity windows and quiet hours; they do not require spontaneous contact to be enabled. If the worker is offline, the message can run when it returns, not while it is stopped. Delivery includes queue and model latency. Cancelling before the timer is claimed prevents it from firing; as with ordinary routines, cancelling a timer does not abort a turn that has already started. Unattended turns cannot create or extend further schedules. Mutation replay uses the existing effect ledger; an interrupted operation with an unknown outcome is not repeated blindly.

## Enable and roll out

`ROLEPLAY_ENABLED` defaults to `false`. Set it to `true` on **both API and workers** only after all processes support the dedicated roleplay execution path. Docker must be configured and its computer image installed.

For the first deployment containing this feature:

1. Keep roleplay disabled while applying the additive migration and deploying new binaries.
2. Drain and stop every worker/API from a pre-roleplay version. Do not enable roleplay during a mixed-version rolling deployment: old workers do not understand the bot type and would run ordinary agent jobs.
3. Enable `ROLEPLAY_ENABLED=true` and restart the upgraded API/workers together.

For rollback across the pre-roleplay boundary, disable new roleplay admission, cancel/drain pending roleplay work, and stop all upgraded workers before restoring old binaries. Existing roleplay bots must not receive work through old APIs/workers; use a maintenance window. The experimental feature does not support mixed pre-roleplay and roleplay-aware processes while active.

The native launcher supports an existing Docker supervisor through `--with-docker`. It also requires the deployment default computer preference to be explicitly set to `this-mac`, preserving existing default-target host computers. Explicit roleplay Docker targets remain Docker.

## Validation

Offline tests cover import bounds/compatibility, lore selection, story isolation, constrained execution, cancellation, queued turns, UI and disabled feature admission. PostgreSQL tests cover encrypted persistence, immutable type, placement restrictions, clear/reset and character edits while a run is active.

The opt-in `packages/testkit/src/roleplay.docker.test.ts` exercises PostgreSQL, actual Docker containers and the internal provider transport against a local model emulator. It verifies orchestration and request structure, not narrative quality from a live model.

## Conversational evaluation rubric v1

Deterministic tests validate bounds, imports, prompt sections, story isolation, message splitting and atomic persistence. They do not establish that a model sounds natural or remembers facts correctly. Quality evaluation is opt-in: use a provider-neutral LLM judge with this versioned rubric and a set of human-reviewed transcripts, record the model and rubric version, and report judge usage separately. A judge failure is unqualified, never a pass.

Score each dimension from 1 (clear failure) to 3 (mixed) to 5 (consistent success), citing transcript evidence:

- **Grounding:** replies and extracted snapshots use only established details; proposals, agreed plans and completed events remain distinct. Imported examples never become memories.
- **Continuity:** relevant details survive long conversations and corrections replace outdated facts. Other stories contribute no details.
- **Rhythm:** reply length and number of messages fit the moment; questions, jokes and callbacks appear when useful instead of as a repeated pattern.
- **Agency and pace:** the character has coherent preferences while leaving the player’s dialogue, feelings and decisions to them; intimacy develops only as supported by the conversation.
- **Style:** chat stays in the character’s message voice, while narrative respects the card’s narration directions.

Calibrate against reviewed examples before comparing changes. Include relative-date plans across midnight and timezone changes, a newer rescheduling or cancellation, a return after an event date without an outcome update, a narrative scene resumed after a long real gap, one ignored spontaneous message, unknown timezone, attempted late-night contact, explicit relationship debug edits, a suggestion that is declined, a corrected personal detail, a quiet reply needing no question, a serious turn after banter, a long conversation requiring compaction, narrative and chat cards, and two separate stories with conflicting facts. Treat unsupported events, cross-story facts and ignored boundaries as failures regardless of the average score. No live-model quality result is implied by the offline suite.
