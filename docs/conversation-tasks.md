# Task conversations and recovery

A bot can have separate task conversations. On web and Electron, the **Tasks** icon
beside the attachment control shows or hides the task panel, initially hidden.
Hiding the panel preserves task instructions being edited. Mobile's matching icon
opens the existing **Conversation work** screen. Open **Tasks** to create one, or
use **Start as task** on an unclaimed queue entry. Group queues require an explicit
recipient. Moving input to a task atomically withdraws it from the original queue;
it cannot run in both places.

Tasks reuse the existing bot identity, computer, runtime, permissions and model settings. Their messages, approvals, Stop action, draft and native session belong to their own thread. Task conversations remain addressable after they leave the newest page. Activity, search and source links open the task itself.

Codex Workspace tasks offer **Write scope** when created on web or mobile. Enter an existing relative project subdirectory. Disjoint scopes can execute concurrently in the original checkout, including tasks for the same bot. The host resolves canonical directories, rejects symlink aliases and folder escapes, and sets the native OS sandbox's working directory and writable roots to that child. Scoped tasks cannot request broader permissions or use application tools that could bypass the filesystem boundary. Shared temporary-directory writes are excluded. A later message in that task keeps the original scope. No worktrees, copies or package installation are created.

Ancestor or identical scopes wait. A task using the whole project, Full access, Pi or another native runtime conflicts with every scoped writer on that host. The coordinator spans bots and computer records on the same registered host; both database admission and durable host fences participate. Stop releases only its owned process after verified cleanup. Waiting questions retain the task's host fence. An expired worker lease does not authorize another writer over an uncertain process; host restart preserves unresolved disk fences. Unsupported uncoordinated host providers and older bridges reject scoped execution. Upgrade API, workers and host together after applying the additive task-scope migration.

All production bridges for one OS user share a private coordinator directory in that user's home, including daemons with different state roots or registration records. Its path must be canonical, owned by that user and accessible only to that user. Task scopes overlapping private native state are refused. Unresolved claims never expire automatically. Tests explicitly supply private temporary coordinator roots.

The installed Codex app-server starts with its process working directory set to the task scope; setting only thread/turn working directories leaves its process directory implicitly writable. Existing hardlinked files are rejected because native path sandboxes cannot distinguish aliases to an inode outside the scope. Host shell commands clean their background children before returning so Pi commands cannot leave an uncoordinated writer.

Scoped creation uses a versioned RPC that older APIs reject. A restrictive database policy also hides scoped conversation runs from older workers and reconcilers, including their system context and expired leases. They retain access to ordinary runs during a rolling deployment. The current worker protocol version is supplied by the database client; older processes cannot silently reinterpret scoped work as a whole-project run.

## Stopped work

**Recover or reassign** opens editable instructions and a bot selection. **Start recovery** creates a deliberate new task with durable provenance back to the stopped run. Earlier effects may already have happened; the recovery instruction tells the runtime to inspect state and ask before repeating uncertain effects. The former checkpoint is never copied into the new run. Concurrent recovery attempts resolve to one successor.

Native recovery uses the original pinned host computer and native run identity, even when bot settings have changed. Before admitting recovery, the host must acknowledge verified terminal cleanup. That acknowledgement is persisted as a receipt; a missing receipt after a host restart is not evidence that the process stopped. Unknown ownership, an unreachable host, an older bridge without strict cleanup acknowledgement or failed cleanup returns a conflict. The UI keeps the reviewed instructions available for retry. Older native runs without a trustworthy pinned binding fail closed.

Local thread compaction supports task conversations. The optional semantic history index remains reserved for direct bot conversations because its current namespace is bot-wide; task history tools use their own authorized thread and local summary.

## Conversation files and routines

**Conversation files** lists existing artifacts and attachments with their source message when that message is visible. Stored bytes include the listed versions; this is logical artifact storage, not host disk usage. Task uploads retain their thread provenance even before sending, and same-name uploads in distinct task conversations do not become versions of each other. No second file store is created.

The computer panel's **Calendar** offers day/week/month views, routine schedules and execution history. Dates follow the viewer's timezone; each schedule is evaluated in its configured timezone. Watches show actual runs, not guaranteed future executions. Dense schedules explicitly request a shorter period. The scheduler is unchanged.

For a bot's first task, suggestions populate an editable draft. **Choose runtime and model** opens existing settings. Suggestions do not send automatically, replace an existing draft or reset the chosen runtime/model.

## Rollout

Apply additive database migrations before updating API/workers. Update the local host bridge together with the backend to enable strict native recovery. Existing direct-bot conversations, Pi checkpoints, group chat and routine scheduling retain their prior behavior. Electron acceptance is deferred; these flows are verified in the web application with shared API contracts.
