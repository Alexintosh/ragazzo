# Local deployment

## One-command local stack with Docker

With the database, dependencies, production build and computer image already installed, configure the root `.env` as described below, including `SANDBOX_SUPERVISOR_URL=http://127.0.0.1:7091` and `SANDBOX_SUPERVISOR_TOKEN`, then run:

```sh
make start
```

This first runs `pnpm db:migrate` against the configured existing database, applying pending schema and job queue migrations and refreshing runtime grants with `DATABASE_MIGRATION_URL`. If migration fails, no local services start. It then starts API, worker, web and the host bridge. It starts a local Docker supervisor when that port is free, or authenticates and reuses an already-running supervisor. The command explicitly grants local host execution, like `native:start`. It does not create a database, copy data, install dependencies, build or download computer images. The stored deployment computer preference must be `this-mac`, preserving existing host defaults while explicit Docker bots stay in Docker.

The managed supervisor uses `DOCKER_SOCKET` if supplied; otherwise it follows the Docker CLI's selected context (or `DOCKER_HOST`). Only local Unix sockets are supported. Its listeners bind to loopback, and automatic image builds are disabled with `SANDBOX_AUTO_BUILD_IMAGE=false`. A missing image or unavailable Docker daemon fails startup with an explanation.

Press Ctrl+C and wait for the terminal prompt before running `make start` again. Signal handlers cover startup as well as steady operation. The launcher sends TERM to its child process groups, waits for shutdown, then forcibly stops any surviving descendants after the grace period. The host bridge closes after API and worker drain. A supervisor started by this command also stops; an existing external supervisor and PostgreSQL remain running. Occupied API/web ports produce an error rather than killing unrelated processes. `make build` rebuilds the existing web/API/worker outputs when code changes.

## Host-only or externally supervised deployment

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

Keep the launcher itself alive for the lifetime of the deployment: it hosts the bridge, so surviving API or web processes alone cannot run host computers. For a background deployment, supervise the whole `native:start` command. If it was terminated abruptly, stop the remaining owned services and restart the stack together. Boot and preview report an unavailable host connection without automatically resubmitting commands.

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
