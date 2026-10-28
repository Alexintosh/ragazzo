# Local deployment without Docker

This entrypoint runs API, worker, web and the authenticated host bridge as local processes. PostgreSQL must already be running, locally or on a separately managed server. It never calls Docker, starts a database, installs a CLI, clones a project or creates worktrees.

Use Node and pnpm versions declared in the root package manifest. Install project dependencies in this checkout using the normal project setup. Configure `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and `SCREEN_PROXY_SECRET` in the root `.env`. Keep the runtime database role separate from the schema owner as in the normal deployment. Do not commit this file. Optional `DATA_DIR`, `API_PORT` and `WEB_PORT` override the local defaults; DATA_DIR defaults to `data` in the checkout.

Apply migrations and build:

```sh
pnpm db:generate
pnpm db:migrate
pnpm native:build
```

Start locally:

```sh
pnpm native:start
```

`native:start` explicitly passes `--allow-host`: running it is local authorization for bots to execute as your OS user. The bridge uses a newly generated process-only credential, binds to loopback and rejects browser-origin requests. The API, worker and web also bind to loopback. Web clients cannot grant this consent themselves. Host authorization ends when the launcher stops. If one service exits, the launcher stops the other owned services and closes the bridge. Ctrl+C shuts down the entire stack, including owned native runs. No service is installed into the OS background startup configuration.

The default computer is the local host. Both Team and Private are available. Native Codex additionally needs an existing signed-in CLI and a project folder. Private host computers separate application state and workspace folders; they do not create separate OS users. The computer panel previews a managed Chrome/Chromium browser on the host, with the same view/control lease flow as other computers. It does not capture or control the personal desktop. An existing Chrome/Chromium installation is required; the launcher never installs a browser.

### Optional Docker placement

To use host and Docker bots together, separately configure an existing sandbox supervisor and install its computer image using the [Docker provider setup](./self-host-sandbox-providers.md#docker-in-stack-supervisor). Set `SANDBOX_SUPERVISOR_URL` and `SANDBOX_SUPERVISOR_TOKEN`, then run:

```sh
pnpm native:start --with-docker
```

Before opting in, explicitly set the deployment's stored computer preference (`deployment_settings.computerHost`) to `this-mac`. The launcher reads this preference and refuses Docker startup otherwise; it never updates the preference or bot records. This keeps existing Default environment bots on the host. Pin a bot to Docker sandbox to use Docker, or Host machine to explicitly use the host. The flag selects Docker as the deployment provider while retaining the authenticated host bridge. Without the flag, the launcher always uses the host, even when `.env` selects Docker.

Before starting any services, the launcher checks the supervisor's authenticated `/readiness` endpoint. It requires Docker to answer and the configured computer image to be installed already. An older supervisor without that endpoint fails this check. The launcher never starts the supervisor, builds or downloads an image, or provisions a computer during startup. The supervisor itself has separate image-build behavior during its own startup and provisioning; manage that separately before opting in.

To update, stop the launcher, update this checkout, apply additive migrations, rebuild and restart. To stop, use Ctrl+C in its terminal. To remove the local deployment, stop it and remove the checkout/build outputs only when desired; database and DATA_DIR contain user data and are deliberately not deleted automatically.

Verification: the API, worker and web production builds started locally with no executables available on PATH, including Docker. API readiness checked the existing PostgreSQL database, the web page and proxied authentication endpoint returned successfully, and shutdown closed both service ports with exit code zero. Graphile workers connected successfully. This smoke used the scripted agent runtime; it does not establish real-provider task acceptance. The test database was externally managed in an existing container, so a separately installed PostgreSQL server remains untested. No database provisioning is performed by this entrypoint.
