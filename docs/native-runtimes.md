# Native coding runtimes

Rakazo supports Codex, Claude Code and ACP agents through the authenticated host computer bridge. The worker never receives provider login credentials. Web, desktop and mobile choose the runtime, authorized host, canonical existing project folder and access policy before any introductory run is queued.

## Browser on the host

Host bots use an owned headless Chrome/Chromium process with a persistent managed profile. Browser tools and the computer panel show the same live page. The preview supports tabs, navigation, pointer, scrolling, keyboard/paste and website dialogs; user input requires the current takeover lease. Bot page tools expose DOM references, owned tab references and browser dialog state. Models that support images also receive browser screenshots and visual actions. Native Codex advertises image support through its runtime rather than the Pi model catalog; unsupported native image capabilities remain unadvertised.

Profiles and tabs bind to the owner, Space, host registration, computer workspace and acting bot. Bots on one Team computer retain separate browser profiles; changing between Team and Private selects distinct computer state. The host bridge launches only its own browser process and private debugging pipe, never attaches to a personal browser, and never exposes a debugging port to clients. The UI receives a sealed preview capability rather than a host credential. Read-only previews cannot submit input or access other host endpoints; control, placement, host revocation and screen generations are rechecked by the existing proxy.

Uploads stay within the authorized workspace (the bot's folder or `shared/` on Team computers). Downloads are staged privately and published without overwriting existing files under that bot's `Downloads` folder; individual downloads are limited to 8 MB. Saved login fills remain origin-bound and cannot be inserted into a JavaScript prompt. Stopping a run cancels its current browser work without closing another bot's browser or a replacement run's session. Stopping a computer or disabling host consent closes its owned browsers; profiles persist for later use. Host registration revocation also closes idle browser sessions and blocks late work for that registration.

When a bot pauses for a committed question, its managed page stays available for the normal idle window, including a manual login through the preview. A rejected or stale pause does not retain browser ownership. Connecting an interactive preview activates the current authorized control lease; releasing it immediately revokes that viewer.

No Docker image or browser download is required when Chrome/Chromium is already installed. This browser integration does not provide OS-level isolation between host bots running as the same user.

## Runtime settings

Use [the typed agent workflow](../.agents/skills/native-runtime-settings/SKILL.md)
for configuration, model inheritance, conflict handling and post-save rereads.
Host availability comes from the existing `me.localHostConfigured` capability.
Changing host clears the draft project folder. Profile autosaves preserve unsaved
advanced settings; the operator applies those settings with Save.
Native runs receive the available application skill catalog as well as explicit
skill invocations. A catalog entry does not grant filesystem or tool access.

In web bot creation and settings, **Browse** opens a directory picker on the selected host. It lists folders within that host's home directory; **Use folder** updates the draft, while **Cancel** leaves it unchanged. Manual entry remains available for other locations. The picker does not upload files, create folders, save the bot or grant host access. Changing host or Space discards the previous listing.

Saving native execution settings resolves an existing absolute project path on the selected host and stores its canonical location. For example, macOS `/tmp/example` resolves to `/private/tmp/example`. Later work uses that saved location rather than following the original alias again; runtime checks still reject a saved canonical path that has become a symlink. The host bridge must support project-path resolution, and unavailable hosts or missing folders fail before saving a new execution configuration.

The web chat header includes a model and effort picker for each bot. Pi uses the configured model connections. Codex reads the installed app-server's model catalog on the selected host and the effective configuration for the saved project, without generating a response. Selections save immediately; **Runtime default** clears both overrides. With an explicit model, **Default** effort uses that model's advertised default; with no model override, the picker reflects the project's Codex configuration. Claude Code and ACP currently report model selection as unavailable.

Codex model changes require the bot to have no queued or active runs. The save rechecks ownership, host registration and execution configuration before committing. Changing model or effort starts a fresh provider session with authorized Rakazo conversation history on the next run; an old session cannot retain the previous effort. Explicit preferences use a distinct host protocol method, so update API, worker and host bridge together. Switching runtime clears incompatible preferences, and Pi duplicates or children do not inherit native model settings.

All native engines share durable start fences, conversation and account bindings, bounded authorized Rakazo history, approval checkpoints, application-tool effect gates, stop/recovery handling and output-file collection. Each engine has separate session records. Changing engine, host, project, permissions or runtime generation starts fresh provider context. Switching back cannot resume the previous generation. Uncertain starts are never automatically resubmitted.

Provider sessions also bind to the server-authorized conversation context: private chat, each messaging channel, and each isolated routine or creation run. A channel cannot inherit a private transcript or another channel's session by sharing the bot's application thread. Checkpoint recovery validates the same context before answering or resuming. Context-bound requests use a distinct host protocol method, so an older bridge rejects them instead of silently ignoring the scope. This separates provider transcripts; it does not turn Full host access into filesystem isolation.

An introductory run exposes only its restricted application tools. Answering its ordinary question authorizes a durable handover: Rakazo records the answer and retirement intent, verifies that the intro's native execution has stopped, then starts a distinct native execution with the user's answer and the full authorized application-tool catalog. It keeps the existing catalog fingerprint check rather than changing tools underneath a pending provider turn. The replacement execution and its Stop target are saved together before launch. Lost retirement acknowledgements retry cleanup without starting the user's work twice. Native retirement leaves the application's own host commands available; a user-requested Stop still cancels both native work and application commands.

Each native question or approval carries a server-recorded interaction identity. Recovery submits only the persisted answer to that exact interaction. If a crash saves the provider cursor before its question card is stored, Rakazo replays the question instead of using an earlier answer.

Update host bridges together with this support: native retirement uses a new method that older bridges reject. Legacy question cards without an interaction identity cannot authorize the broader onboarding catalog; an unbound ordinary resume replays the pending question instead of guessing which earlier answer belongs to it.

## Claude Code

Use an existing `claude` installation or the host's managed installation and sign in locally. Availability reads `claude auth status --json`. Local login presence does not guarantee the upstream service accepts the credential; an authentication rejection during a turn requires signing in again.

The adapter starts its own `--input-format stream-json --output-format stream-json` process. It uses structured control requests for initialization, one-action permissions, batched questions and an SDK MCP server carrying the current authorized Rakazo tool catalog. File and image inputs, session resume, token usage and explicit Markdown output attachments use the shared runtime lifecycle. Inherited settings sources, hooks, project MCP servers, browser integration and plugins are disabled for this process. Background agent and monitor tools are unavailable.

Claude Code currently requires explicitly selected **Full access**. Its shell sandbox does not attest confinement of file tools and hooks, so Rakazo rejects **Workspace** before submitting a turn. Selecting a runtime never silently broadens access.

## ACP

ACP commands are configured by the host operator, never by a bot, renderer, API execution URL or model output. Create `native-providers.json` under the host bridge data directory, owned by the host user with mode `0600`:

```json
{
  "acp": {
    "command": "/absolute/path/to/installed-agent",
    "args": ["--acp"],
    "identity": "local-account-generation-1"
  }
}
```

Restart the host bridge after changing this file. The executable must exist and be executable; relative commands, unknown configuration fields, symbolic-link config files and files readable by other users are rejected. Rakazo does not install an arbitrary ACP agent or accept its command through remote settings.

The adapter negotiates ACP v1 JSON-RPC and reads advertised image, session-loading and HTTP MCP capabilities. Authentication availability is checked with `session/new`, which does not submit a model prompt. ACP v1 has no standard account identity endpoint: `identity` is an operator-controlled account/configuration generation, not a credential. Change it whenever the provider account changes so stored sessions cannot be reused across accounts.

Session loading requires the agent's `loadSession` capability. Application tools require HTTP MCP support; they are exposed through a temporary loopback endpoint with a random per-run bearer credential. The endpoint rejects browser origins, bounds requests, routes only the run's authorized catalog and caches identical request identities. Conflicting request reuse fails. The endpoint is revoked with the owned run.

ACP permission responses select only `allow_once` or `reject_once`; an `allow_always` choice is never used. Unknown client methods are rejected. Client file/terminal execution capabilities are not advertised. ACP does not standardize a workspace confinement guarantee, so **Workspace** is rejected and **Full access** must be explicitly selected.

## Steering and cleanup

Codex supports acknowledged live steering. Claude and ACP follow-ups remain queued for a subsequent turn because their supported protocols do not provide the required per-message acceptance guarantee; shared queue controls hide **Steer** for these runtimes. Initial queued context is still included before launch.

Cancellation terminates only the fresh process group owned by the adapter, waits for exit and verifies the group is gone. It never attaches to a user's separately launched process or uses global process matching. A failure to verify cleanup retains the durable fence and reports an uncertain outcome. Full host access permits the configured agent to act on that host; it is not filesystem isolation.

## Verification

`native-providers.test.ts` drives real owned offline stdio peers for both protocols, including authentication inspection, exact one-action answers, resume, MCP application tools, confinement rejection, stop and a delayed-write check. `native-mcp-server.test.ts` checks bearer/origin authorization and duplicate/conflicting effect requests. Existing Codex and authenticated host transport suites cover the shared supervision boundary.

On the installed Claude Code 2.1.104, authentication inspection and structured SDK-MCP initialization passed. The live model turn returned the provider's structured `authentication_failed` category; successful live execution remains unverified until the host account is signed in again. A user-authorized test configured the installed Gemini CLI 0.25.1 (`--experimental-acp`) in a private fixture. Gemini attempted browser authentication before its ACP server initialized, so the status probe failed and no model prompt was sent. The owned provider group was stopped. Complete sign-in in an interactive Gemini terminal before retrying; live ACP generation remains unverified. Gemini advertises no session-loading support, so its later turns use fresh provider sessions with authorized application context.

Protocol references: [Claude SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py), [Claude sandbox scope](https://code.claude.com/docs/en/sandboxing), [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization), [ACP permissions](https://agentclientprotocol.com/protocol/v1/tool-calls).
