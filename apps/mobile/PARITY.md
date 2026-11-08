# Native workflow coverage

The mobile implementation uses Rakazo's shared RPC contracts, calendar calculations,
message rendering, ask controls, attachment pickers, and artifact cache. It contains
original native screens; no OpenBot implementation code is included.

- `conversation-work`: bot, group recipient, and task queues; revision-checked edit,
  cancellation, reorder, steering, and conversion to a task. Task creation and stopped
  run recovery open separate task conversations. Failed submissions retain their prompt
  and reuse their nonce when retried.
- `task-conversation`: live events, text and attachment sends, ask answers and secret
  dismissal, stop, earlier/newer history, and search-message jumps. Artifact previews,
  downloads, audio playback, and reply thumbnails preserve task authorization scope.
- `conversation-files`: generated files and attachments, family versions, and logical
  storage counts. The existing artifact detail screen provides preview, version choice,
  sharing, and deletion.
- `routine-calendar`: local day/week/month ranges, paginated run history, and future
  occurrences calculated by the shared core calendar functions. Actual runs open their
  conversation message; scheduled occurrences open the routine.
- `workflows`: inspect steps and dependencies, start definitions, inspect runs, open
  node task conversations for approvals, cancel, and recover failed steps. Mutations
  carry current definition/run revisions. Native graph editing is not included; the
  web workflow editor owns graph authoring.
- `new-bot`: optional name, title, and brief followed by progressively disclosed runtime,
  execution target, permissions, project folder, and computer sharing. The create call
  configures runtime and brief together before onboarding and includes a retry key.
  Explicit execution targets expose both Team and Private computer choices in settings.

Bot chat menus expose conversation work, files, and the calendar. Group settings expose
work and files. Workflow supervision is reached from conversation work. Search, activity,
Expo notification taps, and Android native notification links recognize task IDs. A task
notification naming a different Space selects that Space before mounting the transcript.

Multi-step requests bind to the server, signed-in session, Space, and selection sequence.
Late responses after switching contexts cannot publish a new task or change the current
queue. Queue receipts cannot replace a newer revision already seen from polling.

The primary new labels are “Conversation work”, “Start task”, “Queue message”, “Start as
task”, “Workflows”, “Start workflow”, and “Recover step”. Each identifies an explicit
navigation destination or action on its own detail screen; hiding those labels would
leave the operation unnamed. “Runtime and computer” reveals setup controls on request.
The six existing non-English mobile catalogs include the added chrome.

Verification covers mobile TypeScript, the native unit suite, request-scope race checks,
retry nonce retention, task artifact cache separation, task search/notification routing,
and mounted native-screen behavior for task sends and workflow supervision. These checks
run without Electron or a device. No simulator screenshots, physical-device behavior, or
Android native compilation are claimed by this implementation record.

Validated with the mobile TypeScript command and the complete native unit suite: 215
files and 2,360 tests passed. Focused screen and Android source-contract checks were
rerun after the final transcript event-refresh adjustment and passed.
