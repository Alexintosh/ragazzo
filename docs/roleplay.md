# Experimental roleplay bots

Roleplay is a dedicated bot type, separate from operational agents. In **New bot**, enable **RP** beside the name and import a character JSON. An original example is available in `examples/roleplay/lighthouse-keeper.json`.

Supported imports: plain character objects and Character Card v2/v3 JSON, up to 1 MB. The importer reads character description, personality, scenario, example dialogue, first greeting, narrative directions and lorebook entries. Literal primary/secondary keys, case sensitivity, constant entries, ordering, before/after-character placement, scan depth and a bounded lore budget are supported. `{{char}}` and `{{user}}` expand to the character name and `Player`.

Scripts, executable extensions, regex transforms, recursive lore scanning, assets and advanced rendering are not executed. Import warnings identify recognized unsupported features. This is a text-focused compatibility subset, not a complete RisuAI runtime.

## Execution and story state

- The type is immutable. Roleplay uses the internal model transport and a dedicated Docker computer; it cannot switch to Codex, ACP, Claude Code, host execution or a shared computer.
- Model requests run in the application worker, as with the internal Pi path. A real Docker computer is provisioned and verified. Roleplay currently exposes no executable tools, filesystem access or browser capability to the model.
- Model/provider selection uses the existing connection settings. No special model account is required.
- Character configuration is separate from story state. Only the current conversation's narrative messages and its bounded summary enter the roleplay context. Agent instructions, global memories, skills, plugins and operational tools are not loaded.
- Character cards and story state participate in the existing content encryption. Clearing a conversation clears its narrative state and restores the character's first greeting. Duplicating the bot starts a separate story.
- The first version supports individual stories. Groups, operational handoffs, routines, messaging integrations, file attachments and live calls are unavailable. Speaking a reply aloud remains available.
- Web/Electron share the import UI. Native mobile can read and converse with an imported character; creation directs the user to the web import flow.

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
