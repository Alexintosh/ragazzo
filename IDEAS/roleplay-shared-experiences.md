# Relational core and shared experiences

Status: product direction and future design notes. This document does not activate capabilities or authorize external integrations. Current implemented behavior is described in [roleplay.md](../docs/roleplay.md).

## Priority: everyday interaction

The immediate focus is a character who maintains a coherent relationship through conversation, remembers shared details and takes appropriate initiative. Spontaneous contact can seek company, share a joke or revisit a mutual interest. It need not deliver useful information every time. This applies to friendship, play and collaboration as well as romance.

The next core milestones are:

1. Validate the existing conversational continuity, temporal context, relationship state and spontaneous delivery against the configured model. Preserve the distinction between automated correctness tests and live conversational quality.
2. Add media to ordinary and spontaneous messages: memes, songs and other real shared links; character photographs; audio messages. The content should fit the character, conversation and moment, with a short personal accompaniment when appropriate.
3. Carry reactions to those exchanges into later conversation: which song the user liked, a joke that became a callback, a photograph already sent. Repeated content should be intentional rather than an accidental replay.

Character photos can initially come from an uploaded album. Generation can follow through a separately configured provider; its endpoint and request format remain undecided. A voice message is a persistent conversational attachment, distinct from the current read-aloud action. Song sharing can begin with a verified link rather than an uploaded audio copy. Browsing, link discovery, generation and playback need their own explicit capability support.

The existing opt-in, quiet hours, unanswered-contact stop and rate limits should govern media contact too. A failed upload or generation must not leave a message claiming an attachment exists. A late asset completion must not revive a cancelled or superseded send.

## Research observation: experiences leave an aftermath

Product research described a cycle of ordinary chat, a proposed narrative encounter, a short interactive episode, then an immediate follow-up that recalls the emotional tone of the episode. Relationship levels and communication modes can make progression visible. These are reported interaction observations, not a verified account of another product's implementation.

The promising mechanism is continuity between the episode and everyday conversation. After a fictional cafe encounter involving a personal disclosure, the next message might refer to feeling comfortable enough to share it. Later exchanges can recall a specific joke, choice, disagreement or unfinished topic from that encounter.

An experience therefore has several possible outcomes: established events, newly shared information, unresolved threads, callbacks and supported changes to the character's relationship state. A numeric reward alone cannot represent those outcomes. Visible relationship levels, encounter scores and progression unlocks remain product ideas to evaluate; they are not requirements for the current core.

## Future experience candidates

| Experience | Possible interaction | Authoritative state |
| --- | --- | --- |
| Short narrative encounter | Suggested replies plus free text; a clear beginning and ending | The accepted story transcript and explicit scene state |
| Tic-tac-toe or chess | Play turns while the character comments in its own voice | The game's rules, board and move history |
| Watching the user play | React to observed events and discuss the session afterwards | Observations actually received, with timestamps and uncertainty |
| Choosing a film or music | Discuss options and navigate a supported catalog together | Available catalog entries and the user's accepted selection |
| Watching a film together | Occasional timely comments, pauses for discussion and a later follow-up | Confirmed media identity and actual playback position |

Small games offer a useful early experiment after the media core: their state can be explicit and their outcomes checked. Character narration must follow the legal moves and actual result. It should not invent moves or victories.

External game observation, streaming-service interaction and broad computer use require separate feasibility work. They are future ideas, not capabilities to add during the current core work.

## Efficient co-watching: a hypothesis to test

Continuous visual interpretation of a whole film is not the starting assumption. A possible design uses a confirmed title or edition, player position and events such as pause, resume and seek, supplemented by occasional observations when necessary. A bounded context relevant to the current playback position could support intermittent comments.

Playback position is authoritative; elapsed wall-clock time alone loses synchronization when the user pauses or seeks. Timeline context must be specific to the edition and restricted to what has been reached, with an explicit spoiler policy. General knowledge of a film is different from evidence that the user has watched a scene. Missing or uncertain observations should remain uncertain.

Supported player signals, access to appropriate timeline material, streaming-service constraints, latency and model costs all need a prototype. No compatibility with a particular streaming service is assumed.

## Architectural decisions to preserve while building the core

- **One continuous conversation.** Activities should feel like part of talking to the same character. Starting and ending an activity can be explicit without creating a disconnected personality or forcing the user through technical runtime choices.
- **Separate character and operational execution.** Keep the dedicated RP runtime, character configuration and per-story memory. A future experience controller can provide observations and narrowly scoped actions through a supported session. The current RP bot does not gain arbitrary assistant tools or freely combinable runtime adapters.
- **Use typed content and stable references.** Extend the existing shared message/asset infrastructure for actual attachments and links. Keep provider credentials and transport details outside character cards. Record source, identity and delivery status so the character can distinguish a proposed item from one successfully shared.
- **Keep experience state authoritative.** A game engine owns legal moves; a player owns playback position; the transcript records accepted narrative events. Model-generated commentary does not mutate those facts implicitly.
- **Preserve provenance and story scope.** Remember what was observed, shared or explicitly established, including timestamps and origin. Keep other stories, private/team data and imported examples separate. Clearing a story must also invalidate its pending contact and experience work.
- **Reuse delivery guarantees.** Model decisions, asynchronous media work and future activity outcomes should respect cancellation, retries, deduplication, current preferences and the last-moment check for a newer user message.
- **Keep implementations proportional.** Add the smallest provider boundary needed for each working capability. Use these notes to avoid incompatible storage and execution choices; introduce a general experience framework only when concrete integrations justify it.

## Evaluation questions

Does a shared item create a meaningful conversational exchange? Does the character remember the user's reaction without repeating it mechanically? After an experience, does its follow-up reflect specific established events and tone? Do suggested choices and free-text replies both influence the outcome? Can the user postpone or decline naturally? Does the character distinguish observed events from guesses, and preserve quiet periods and boundaries as the relationship develops?

Evaluate these questions through reviewed conversations and the versioned conversational rubric. Test delivery, game rules, clocks, isolation and attachment lifecycle deterministically.
