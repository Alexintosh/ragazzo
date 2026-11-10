---
name: native-runtime-settings
description: Inspect and configure a Rakazo bot runtime, host, project, access and Codex model through typed RPC.
---

Use the authenticated Rakazo RPC client in the selected Space. Read
[the runtime contract](../../../docs/native-runtimes.md) and
[typed procedures](../../../packages/contracts/src/rpc.ts). Never use direct database writes.

1. Read `bots/list` and identify the operator-selected bot. Read `hosts/list`
   and `bots/executionStatus`. Preserve the exact bot, host, project and access
   requested by the operator. Host registration, ownership and enabled host
   consent are prerequisites; installing or signing in to a provider is separate.
2. Explain the selected access before saving. Codex supports Workspace (write
   confinement) and Full access. Claude Code and ACP require Full access.
   Workspace confines file writes, not every read or network request. Selecting
   a runtime does not authorize unrelated commands or deployment.
3. On explicit authorization, call `bots/setExecution` with `botId`,
   `runtimeKind`, `executionTarget: "host"`, `registeredHostId`, absolute
   `projectPath` and `runtimePermission`. The server resolves the canonical
   existing folder on the selected host and rechecks ownership under lock.
   Active runs and conflicting computer operations prevent changes. Do not
   cancel runs or weaken access automatically to resolve a conflict.
4. Reread `bots/list` and `bots/executionStatus` to verify the saved canonical
   path, runtime, host and permission. A saved configuration is not evidence of
   successful provider login or a completed run. If the response is lost, reread
   before retrying; do not create another bot or run a prompt as a probe.
5. For Codex, read `bots/runtimeModels` for that bot's host/project catalog.
   `bots/setRuntimeModel` with `modelId: null, thinkingLevel: null` selects
   Runtime default, inheriting the host's effective Codex project configuration.
   An explicit model overrides it; null effort with an explicit model uses the
   advertised model default. The runtime does not inherit another open Codex
   window's transient selection. Claude/ACP model selection is unavailable.
6. Model saves validate the live catalog and compare the execution configuration
   before commit; execution changes use the existing locked ownership and active
   run checks, not a client revision token. On conflicts, reread and present any
   changed selection before retrying. Execution and model saves are separate:
   if only the first succeeds, report it and reread rather than rolling back
   another actor's changes. Runtime switches clear incompatible model overrides;
   configuration changes start fresh provider context on the next run.

No provider prompt, message, deployment, installation, login or transaction is
implied by configuring a bot. Verify configuration with read-only RPC calls.
