# Registered execution hosts

A registered host belongs to one person in one Space. Selecting Host in a bot's runtime settings offers that person's registered hosts and the deployment's local bridge. A registered host is a trusted execution machine: its owner can see project files and everything sent to the runtime. Registration requires an explicit trust acknowledgement. The token is encrypted with the configured secret store and never returned by registry APIs.

Start the bridge on the machine that should run commands:

```sh
pnpm host:start --allow-host --data-dir /path/to/private/host-data --port 7092
```

The command requires local consent on each start, listens only on loopback, and stores a random credential in `host-token` inside that data directory with mode 600. Use `--token-file /path/to/private/token` to reuse an existing private credential file. Read that file locally and enter its value in **Register host**, together with a name and the bridge origin. Startup output never prints credentials. Stopping the bridge revokes local access, closes active requests and terminates owned commands. Codex runs need Codex CLI installed and signed in locally on that host; no model account credential crosses the bridge.

For an API on the same machine, an origin such as `http://127.0.0.1:7092` works. For a different machine, put a TLS reverse proxy in front of the loopback listener, forward `/computer`, preserve `Authorization`, and allow streamed responses. Register the HTTPS origin, without a path, query, fragment or URL credentials. Restrict proxy ingress to the API and worker network. Never expose the plain HTTP listener directly. Both API and worker must be able to reach the registered origin and use the same database and secret store.

**Check** verifies the authenticated connection and current local consent. **Revoke** permanently disables that registration for new requests and durably records cleanup of its owned work. Rakazo cancels the affected runs and asks the original host to stop their exact persisted execution identities, including native provider processes. Cleanup uses a private teardown path; revoked registrations cannot execute new work through it. Unrelated processes are not targeted.

The registration shows **Stopping work** until the host acknowledges run cleanup and cancellation of its managed CLI setup sessions. An unavailable host or an uncertain response keeps this state pending; the worker retries from the persisted cleanup journal. Repeating Revoke is also safe. A cancelled application run alone does not prove that its host process has stopped. If the host is offline or a setup process survived a host crash, local cleanup may still be required before acknowledgement can succeed.

Host identity and credentials are immutable. To rotate a token or change an endpoint, register a replacement and select it after stopping the bot and releasing its computer. Each host has separate Team and private computer identities and home keys; switching retains the old computer and workspace. Native runs persist the original registration, computer and execution identity before RPCs. Resume, answers and stop resolve that persisted registration, and a revoked or mismatched host fails closed instead of falling back to another machine. An execution request accepts a registry ID, never a caller-selected transport URL.
