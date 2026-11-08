# Native Codex bots

For Claude Code, ACP, shared capability limits and their validation state, see [Native coding runtimes](native-runtimes.md).

Rakazo can run Pi bots in Docker and Codex bots on the local host in the same deployment. Runtime, execution target, project folder and native permission policy are stored per bot. Existing bots retain Pi and the deployment's default computer placement.

## Setup

1. Apply the additive `20261026170000_bot_execution_settings` migration using the normal database deployment process. Upgrade API, worker and desktop together before enabling native bots; older workers do not understand the new runtime.
2. Use the desktop-managed local Docker deployment and enable local host access in the desktop app. The existing authenticated host bridge serves both computer operations and Codex. Web and mobile settings cannot grant local consent.
3. Install Codex CLI and sign in locally. P0 uses an existing installation and its account; it does not download the CLI, collect login credentials or send a Rakazo model key to Codex. Protocol implementation was checked against CLI 0.162.1, including its experimental background-terminal cleanup API; compatibility with other releases needs validation.
4. Create a bot normally, then open its settings. Select **Codex**, **Host**, a canonical absolute **Project folder**, and **Workspace** or **Full access**. Save and refresh the Codex status. Runtime and placement can also be selected atomically during bot creation.
5. For a Pi bot that must stay isolated regardless of the deployment default, explicitly select **Docker** in its settings.

Explicit host placement requires an enabled host bridge; it is available in the native launcher and alongside Docker deployments. Native process supervision supports macOS and Linux; Windows is rejected. CLI discovery checks absolute PATH entries and common local installation directories without starting a login shell. The managed host browser and its preview are described in [Native coding runtimes](./native-runtimes.md#browser-on-the-host).

The project must already exist. Resolve symlinks before entering its path. Codex edits that checkout directly: Rakazo does not create a Git worktree or snapshot the external project. Bots pointing at the same project share its files. Their session identities remain separate; this is not filesystem isolation.

## Permissions and sessions

**Workspace** maps to Codex workspace-write with the selected project as a writable root. Network access and temporary-directory writes are enabled. **Full access** maps to Codex danger-full-access. Both use on-request approvals handled by the user. A request includes the command and working directory, or file paths, bounded diffs and any requested write root. Unknown file-change scope fails closed. Approval is for one action; there is no persistent “allow all” choice.

The broker starts and owns its own `codex app-server` process group. It never attaches to or terminates an independently launched user session. Provider apps and plugins are disabled for these processes. Each effective MCP server is explicitly disabled for the selected project; an empty configuration table alone does not disable inherited servers. Native Codex tools remain available. Rakazo application tools are registered as provider-native dynamic functions over the same authenticated host bridge; no additional port or MCP server is required. Tools execute on the API worker through its existing run lease, authorization, secret, approval and effect gates. The host receives only tool descriptions, schemas, call arguments and bounded results; connector routing metadata stays on the worker.

Session mappings bind bot, conversation, project, computer, permissions, account, runtime-configuration generation and conversation-history generation. Changing execution configuration starts fresh provider context while retaining application history; switching back to Codex cannot resume a session from before the switch. Clearing a conversation changes its history generation, so a subsequent turn cannot resume the cleared provider context. Changing account or the offered application-tool catalog starts a fresh native session with bounded application conversation history. A pending turn cannot resume under a different account or catalog. Session mapping and start-fence files live in the private host bridge directory; no account credentials are stored in those records.

Changing execution settings is rejected while the bot has active, queued or waiting work. Explicit targets use dedicated computer records and retain previous computer files. Switching one bot does not change another bot's Team Computer.

## Stop and recovery

Stop, conversation clear, bot deletion and local-access revocation interrupt the owned turn and clean its background terminals before closing the app-server. Normal completion also cleans these terminals; background commands do not persist between runs. A terminal-cleanup capability check runs before a new turn starts. If cleanup cannot be verified within the bounded shutdown deadline, the conversation remains fenced and the error reports an uncertain outcome. Paused approval runs are included even after releasing their execution lease. Transport or consumer failure also attempts an authenticated abort using a fresh cancellation signal. An application-tool response whose host acknowledgement is lost stays checkpointed for replay; the live provider turn is retained during recovery. A disconnected host has a bounded orphan timeout.

A run's native start is fenced on disk before `turn/start`. Reconnecting to a live broker can reuse its buffered events. An uncertain start or host restart never automatically resubmits the same turn. If its result cannot be recovered, the run fails and asks the user to inspect the project before starting new work. Completed conversation mappings can be resumed by later turns. This prevents automatic duplicate submission; it does not roll back changes already made in the project.

Pending provider approvals and application-tool approvals remain alive for up to 30 minutes while the host process is available. Application-tool pauses persist the exact pending call and its effect occurrence before pausing; resumption re-enters the existing authorization gate with the same execution identity. Completed results are persisted before replying, and identical result replays are acknowledged without repeating the application effect. They do not survive termination of the app-server process. Duplicate identical answers are acknowledged without executing twice; conflicting answers are rejected.

Native follow-up messages and explicit **Steer** requests are submitted to the owned active turn with Codex's acknowledged steering operation. Submission identities prevent replay from injecting the same message twice. Batched questions are presented as individual cards and replied to the provider only after every question has its own answer; concurrent approval requests wait their turn.

Chat files are copied into the authorized host computer's attachment directory before native launch or steering. Images also reach Codex as image inputs. Produced files explicitly linked in Markdown, and native generated images saved within the project, are attached to the conversation when artifact storage is available. Collection accepts supported regular files inside the canonical project only, refuses symlinks and external links, and allows up to 10 files and 8 MiB total per run. It does not scan the project for other files.

## Current limits

- Native provider secret-input questions are refused; use local sign-in. Rakazo application tools, including their existing protected-input gates, are available when offered to the bot. Pi-owned `run_subagent`, `ask_user` and `request_takeover` callbacks are omitted from the native catalog. Native questions use Codex's question protocol; helper delegation and screen takeover are unavailable. The conversation supports explicit deferred text requests with edit, cancel and reorder controls before acquisition. See [Conversation queue](conversation-queue.md).
- Native session compaction belongs to Codex. Pi model settings, model credentials and Pi history-compaction jobs are not used for native execution.
- Mobile and web can configure and supervise an authorized host; neither runs Codex locally. Registered hosts, managed setup and additional coding runtimes have separate configuration and validation requirements; see the shared runtime documentation.

## Validation

Deterministic application-tool tests cover schema validation, private connector routing, unknown/forged requests, actual executor approval and rejection gates, effect-occurrence restoration, pause/resume, lost-result acknowledgement replay, catalog/account changes and revocation. Installed-provider acceptance of dynamic application tools remains to be exercised.

Deterministic tests cover contracts and legacy defaults, settings ownership and placement, native protocol translation, approval scope and answer identity, lost-response replay protection, usage accounting, CLI discovery, runtime cleanup, stop/clear/delete, executor routing without Pi credentials, and web settings payloads.

Local web verification exercised PostgreSQL 16 and real Codex CLI 0.162.1 through an authenticated host bridge: command execution, usage accounting, session resume, conversation clear, approve/reject, Stop while active or awaiting approval, and local-access revocation. Stop and revocation checks waited beyond the interrupted command's scheduled completion and confirmed no delayed write. The test harness used an in-memory job queue.

Before release, also validate the production job queue, a Pi/Docker and Codex/host pair, and host restart after an uncertain start. Compatibility with other CLI versions and PostgreSQL 18 remains unverified. Desktop Electron E2E belongs in CI's virtual-display job, per repository instructions.
