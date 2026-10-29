# Conversation engines

Eros is an optional conversation engine for roleplay bots. It owns character prompts, transcript context, memories and its six-axis relationship state. Rakazo owns user access, bot identity, message delivery and durable request tracking. It does not run Eros through the internal roleplay runtime or translate Eros scores into Rakazo's internal relationship scores.

The first integration uses pre-provisioned Eros persona genomes and direct text conversations. It does not give Eros a computer, tools, plugins, schedules, operational actions, groups, attachments or live calls. A character's claim that it performed an action does not execute that action. Native mobile can converse with an existing engine bot; creation is available through the web/Electron flow.

## Connect a service

Set `ROLEPLAY_ENABLED=true` and the same `CONVERSATION_ENGINES` JSON on **both the API and every worker**. Leave `CONVERSATION_ENGINES` unset to keep the external engine unavailable. Existing internal bots keep their current engine; switching an established bot to Eros is unsupported.

Apply the additive database migration and deploy Eros-aware API/worker binaries with the engine configuration unset first. Enable it only after every old worker/API has stopped; an older roleplay worker cannot honor this external engine boundary. For rollback to a version without engine support, stop admission and drain/stop engine work before restoring older binaries. Keep Eros bots unavailable to those older processes.

```dotenv
CONVERSATION_ENGINES='[{"id":"eros","baseUrl":"http://127.0.0.1:5185","jwtSecret":"<dedicated-service-signing-secret>","callerSecret":"<dedicated-service-caller-secret>","characters":[{"id":"22222222-2222-4222-8222-222222222222","name":"Your character"}]}]'
```

Replace the example UUID with the actual genome UUID returned by seeding your service. `jwtSecret` must match the service's `SUPABASE_JWT_SECRET`; optional `callerSecret` must match `CALLER_SECRET` when its gate is enabled. Each secret must contain at least 32 characters. Use independent random values dedicated to this service, separate from Rakazo login/authentication secrets. Only character names, IDs and capability flags reach clients. Do not place this JSON in frontend build variables or commit it.

The base URL comes only from deployment configuration. Public endpoints require HTTPS; private/Docker endpoints can use HTTP. Requests refuse redirects and apply response-size and time limits. This recipe uses a private service with the caller-secret gate enabled. Eros 2.5.2's JWT validator accepts some tokens without expiration and does not enforce issuer/audience. Rakazo issues signed tokens with a five-minute expiration, but this does not repair the upstream validator; keep the service behind the dedicated caller-secret boundary and restrict its network reachability.

For an already running service, configure its dedicated auth secrets, native model/embedding settings and imported characters before enabling Rakazo. No model or character settings are inherited from Rakazo's ordinary model connections. In **New bot**, select RP, then Eros and an available character. Eros character/model edits belong in the service's configuration.

## Separate persistent Docker deployment

[`infra/companion/docker-compose.yml`](../infra/companion/docker-compose.yml) is an optional independent project. It does not start as part of Rakazo's normal Compose stack and does not reuse the disposable evaluation panel or its ports. It pins the previously evaluated ARM64 Eros 2.5.2 and pgvector artifacts:

- Eros: `ghcr.io/etherfunlab/eros-engine@sha256:8fc6240a83dbecead160b852f2cefabfd407a101078dc59856d4a1ff246fcb4d`.
- PostgreSQL/pgvector: `pgvector/pgvector@sha256:a45475a5bc7882f19e9ca17d49b67f665fa04d500350de2c47af325662445aec`.

The recipe requires those images to be present and has `pull_policy: never`. It does not download or build them automatically. The Eros digest was evaluated as ARM64; other architectures need a separately verified image or explicit emulation. Image pinning identifies the artifacts, not proof that the binaries match reviewed source. See [the evaluation](../IDEAS/eros-engine-evaluation.md).

Both services run without root, Linux capabilities, privilege escalation or writable root filesystems. PostgreSQL uses a dedicated named volume and an internal network, without a published database port. Eros publishes only `127.0.0.1:5185` and has a separate service network for outbound model requests. The service deliberately has model-provider network access; it is not an air-gapped sandbox. Nothing mounts Rakazo's database, host files beyond the supplied configuration, or the Docker socket.

This recipe has been reviewed statically; starting it and validating the pinned images on the deployment host is an operator step. Resource limits are starting values, not capacity measurements.

From the repository root:

```sh
cp infra/companion/.env.example infra/companion/.env
chmod 600 infra/companion/.env
mkdir -p infra/companion/personas
```

Replace all placeholders in the companion `.env`. Generate the database password, signing secret and caller secret independently, for example with `openssl rand -hex 32`. Keep the database password URL-safe because the recipe inserts it into `DATABASE_URL`. Do not reuse an evaluation secret. These files are ignored by Git.

Create `infra/companion/model-config.toml` and supply your own `*.toml` persona files in `infra/companion/personas`. Mounts refuse missing paths. The engine user must be able to read these files and traverse their directories. Keep model credentials in the private `.env`, not in the model config.

The original [`model-config.example.toml`](../infra/companion/model-config.example.toml) shows minimal endpoint/model routing. It can exercise chat and affinity after replacing its endpoints and model IDs, but **does not enable long-term memory extraction or profile extraction**. For a complete setup, author those native tasks using the [pinned upstream configuration reference](https://github.com/etherfunlab/eros-engine/blob/39211ecd83939be92bf40960e031ff168966a753/docs/model-config.md) and its [full example](https://github.com/etherfunlab/eros-engine/blob/39211ecd83939be92bf40960e031ff168966a753/examples/model_config.toml). Present extraction-task sections require their native JSON-producing prompts; omitted sections disable extraction. Do not replace missing embeddings with zero/fake vectors.

Embeddings must return exactly **512 dimensions**, with the same vector space used for writes and reads. The example routes embeddings through an OpenAI-compatible endpoint. Omitting that task makes Eros default to native Voyage, requiring `VOYAGE_API_KEY`. Upstream still requires `OPENROUTER_API_KEY` at startup when overriding its endpoint; set it to the actual key accepted by your configured model service. If using additional custom provider names, pass the corresponding native provider credentials into the engine deliberately. They are not inherited from the host.

A minimal operator-authored persona seed has this shape:

```toml
name = "Your character"
system_prompt = "Describe your original character and the intended conversation style here."

[art_metadata]
timezone = "Europe/Lisbon"
```

Seed names identify genomes: seeding the same name updates that genome in place and preserves its UUID. Coordinate persona edits with active users. Names, prompts and metadata are owned by the operator; Rakazo stores only the selected genome ID and the safe display name.

Define a convenience command that always uses this separate project and its own environment file:

```sh
companion() {
  docker compose --project-name rakazo-companion \
    --env-file infra/companion/.env \
    -f infra/companion/docker-compose.yml "$@"
}

companion config --quiet
companion up -d postgres
companion run --rm migrate
companion run --rm seed
companion up -d engine
curl --fail http://127.0.0.1:5185/healthz
```

Run these only after replacing the configuration placeholders and selecting the intended deployment host. Migrations target only the companion database and are explicit; `serve` does not apply them. Record the persona UUID printed by the seed command, or query this database:

```sh
companion exec postgres psql -U companion -d companion \
  -c 'SELECT id, name FROM engine.persona_genomes ORDER BY name;'
```

Use that UUID in `CONVERSATION_ENGINES`, then restart the upgraded Rakazo API and workers together. The health endpoint checks service liveness; it does not establish working model credentials, embeddings or extraction. Validate one synthetic conversation, a restart with persisted state, and a second isolated conversation before admitting real conversation data.

When API/workers run on the host, use `http://127.0.0.1:5185`. When they run in Docker, attach **only those containers** to the external `rakazo-companion-service` network and use `http://companion-engine:8080`. Container loopback is not the host loopback. Do not attach Rakazo containers to the companion database network or publish PostgreSQL. Docker network attachment is deployment-specific; the standard Rakazo stack is unchanged by this optional file.

The recipe disables periodic dreaming, snapshots, world/town/stories, the asynchronous queue worker and the scheduled profile rebuilder. Per-turn native processing still runs for tasks configured by the operator; disabling scheduled profile rebuilding does not disable a rebuild triggered by enough newly extracted facts. Raw prompt logging, BYOK, BYOC and export/erasure secret endpoints are not enabled. Enabling additional upstream features requires a separate configuration review rather than changing the Rakazo adapter.

The evaluation panel's English prompt substitution remains an experimental gateway feature. This integration sends requests directly to the native service and does not install that gateway or translate engine-owned prompts. An English persona can request English replies; it does not translate native affinity, reasoning or extraction instructions. Do not assume the panel's language setting carries over.

## Turn lifecycle and retention

Each Rakazo story/history generation gets a persisted random Eros user UUID and external session binding, separate from real account IDs. Eros has user-global memories shared across personas; this synthetic identity boundary prevents sharing between Rakazo stories. The adapter's default memory scope remains Eros's native `neutral_and_relationship` injection setting. Scope controls do not disable memory writes.

Rakazo persists an immutable request and UUID `client_msg_id` before sending a turn. Eros deduplicates that key permanently for the session. After a disconnect or worker restart, Rakazo reuses the same ID to recover the reply before submitting another turn. A duplicate still generating remains pending; a terminally failed duplicate cannot be regenerated under that same ID. An unavailable service causes a clear failure/pending result instead of falling back to the internal runtime.

**Stop stops Rakazo delivery; it does not cancel an accepted Eros turn.** Eros continues generation and may save the reply and update memories after its connection closes. The next message first reconciles unfinished external work. Local replies are buffered until an authoritative final event, so superseded upstream output is not committed as the answer. Silent, truncated and incomplete turns are not reported as successful empty messages. A final reply does not acknowledge completion of Eros's asynchronous memory/affinity processing; the native protocol has no such completion endpoint.

Clearing history is unavailable for Eros conversations because it would leave the external engine's context intact. Create a separate bot/story for a separate conversation. Hard deletion of Eros bots, and accounts or spaces containing them, is rejected before teardown until operator cleanup is available. Archiving remains available and does **not** erase the external service's stored data. Operators must manage external retention, encrypted backups and erasure separately. Eros's optional user-erasure endpoint removes derived knowledge but explicitly retains chat sessions/messages and numerical relationship state; it also requires traffic to quiesce so in-flight extraction cannot repopulate data. Archive and `force_new` are not erasure operations. This integration does not claim complete upstream deletion.

The companion database survives `companion down` and ordinary engine restarts. Back it up independently before migrations or upgrades and test restoration with the matching pinned service. Do not use `down --volumes` for a normal stop: removing that dedicated volume destroys the service's durable conversation state. Keep Rakazo's persisted session/turn bindings alongside companion backups; independently restoring one system can leave them out of sync.

Eros is an independently deployed AGPL-3.0-only service; Rakazo's adapter contains original HTTP integration code and no embedded upstream source. The upstream image, native configuration examples and modifications retain their own licensing obligations. Use the pinned upstream source/license when preparing a deployment or distributing a modified service.

## Verification of the first integration

Deterministic tests cover the HTTP protocol, character admission, safe catalog projection, tenant isolation, encrypted turn persistence, lease contention, replay after interruption and Stop, and deletion preflight. PostgreSQL regression tests also cover the existing internal roleplay and account-deletion paths. A real two-turn Eros trial exercised the Rakazo executor with a synthetic owner: both turns completed, each saved one reply, and a fresh executor reused the persisted session without invoking local roleplay context or computer capabilities. This is an orchestration check, not a calibrated conversation-quality evaluation.

The web creation selector was checked in desktop and mobile viewports with a synthetic catalog. The separate persistent Compose recipe has not been started by this verification; it remains an explicit deployment step.
