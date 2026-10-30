# Conversation engines

Eros is an optional conversation engine for roleplay bots. It owns character prompts, transcript context, memories and its six-axis relationship state. Rakazo owns user access, bot identity, message delivery and durable request tracking. It does not run Eros through the internal roleplay runtime or translate Eros scores into Rakazo's internal relationship scores.

The first integration uses pre-provisioned Eros persona genomes and direct text conversations. It does not give Eros a computer, tools, plugins, schedules, host actions, groups, attachments or live calls. A character's claim that it performed an action does not execute that action. Native mobile can converse with an existing engine bot; creation is available through the web/Electron flow.

## Connect a service

Set `ROLEPLAY_ENABLED=true` and the same `CONVERSATION_ENGINES` JSON on **both the API and every worker**. Leave `CONVERSATION_ENGINES` unset to keep the external engine unavailable. Existing internal bots keep their current engine; switching an established bot to Eros is unsupported.

Apply the additive database migration and deploy Eros-aware API/worker binaries with the engine configuration unset first. Enable it only after every old worker/API has stopped; an older roleplay worker cannot honor this external engine boundary. For rollback to a version without engine support, stop admission and drain/stop engine work before restoring older binaries. Keep Eros bots unavailable to those older processes.

```dotenv
CONVERSATION_ENGINES='[{"id":"eros","baseUrl":"http://127.0.0.1:5185","jwtSecret":"<dedicated-service-signing-secret>","callerSecret":"<dedicated-service-caller-secret>","characters":[{"id":"22222222-2222-4222-8222-222222222222","name":"Your character"}]}]'
```

Replace the example UUID with the actual genome UUID returned by seeding your service. `jwtSecret` must match the service's `SUPABASE_JWT_SECRET`; optional `callerSecret` must match `CALLER_SECRET` when its gate is enabled. Each secret must contain at least 32 characters. Use independent random values dedicated to this service, separate from Rakazo login/authentication secrets. Only character names, IDs and capability flags reach clients. Do not place this JSON in frontend build variables or commit it.

The base URL comes only from deployment configuration. Public endpoints require HTTPS; private/Docker endpoints can use HTTP. Requests refuse redirects and apply response-size and time limits. This recipe uses a private service with the caller-secret gate enabled. Eros 2.5.2's JWT validator accepts some tokens without expiration and does not enforce issuer/audience. Rakazo issues signed tokens with a five-minute expiration, but this does not repair the upstream validator; keep the service behind the dedicated caller-secret boundary and restrict its network reachability.

For an already running service, configure its dedicated auth secrets, native model/embedding settings and imported characters before enabling Rakazo. No model or character settings are inherited from Rakazo's ordinary model connections. In **New bot**, select RP, then Eros and an available character. Shared character and model edits belong in the service's configuration. Per-bot native request settings are available in bot settings.

## Separate persistent Docker deployment

[`infra/companion/docker-compose.yml`](../infra/companion/docker-compose.yml) is an optional independent project. It does not start as part of Rakazo's normal Compose stack and does not reuse the disposable evaluation panel or its ports. It pins the previously evaluated ARM64 Eros 2.5.2 and pgvector artifacts:

- Eros: `ghcr.io/etherfunlab/eros-engine@sha256:8fc6240a83dbecead160b852f2cefabfd407a101078dc59856d4a1ff246fcb4d`.
- PostgreSQL/pgvector: `pgvector/pgvector@sha256:a45475a5bc7882f19e9ca17d49b67f665fa04d500350de2c47af325662445aec`.

The recipe requires those images to be present and has `pull_policy: never`. It does not download or build them automatically. The Eros digest was evaluated as ARM64; other architectures need a separately verified image or explicit emulation. Image pinning identifies the artifacts, not proof that the binaries match reviewed source. See [the evaluation](../IDEAS/eros-engine-evaluation.md).

Both services run without root, Linux capabilities, privilege escalation or writable root filesystems. PostgreSQL uses a dedicated named volume and an internal network, without a published database port. Eros publishes only `127.0.0.1:5185` and has a separate service network for outbound model requests. The service deliberately has model-provider network access; it is not an air-gapped sandbox. Nothing mounts Rakazo's database, host files beyond the supplied configuration, or the Docker socket.

The pinned recipe has been started with a dedicated database and a synthetic conversation. Restarting the engine retained its session binding. Resource limits are starting values, not capacity measurements; validate your own model and embedding configuration before use.

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

### Optional model gateway and prompt translation

[`infra/companion/model-gateway.py`](../infra/companion/model-gateway.py) is a stdlib-only gateway for an operator-configured OpenAI-compatible model endpoint. It is optional: the base Compose recipe does not start it. Add it in the ignored `infra/companion/docker-compose.local.yml` and include that file in each Compose command when using this deployment variant. Run it as an unprivileged, read-only service on the service network, with no published port or database-network access. Supply a Python runtime already available in your environment.

Set `MODEL_BASE_URL` to the upstream `/v1` URL and `GATEWAY_TOKEN` to a dedicated credential accepted only by this gateway. Set the engine's provider credential to that token. Optional `MODEL_API_KEY` is sent only upstream; the gateway token is never forwarded. `MODEL_ID` can restrict requests to a single model. Route native chat and embeddings to the gateway's `/v1/chat/completions` and `/v1/embeddings` endpoints. Unsupported upstream embeddings remain unsupported: the gateway does not synthesize vectors or enable memory extraction.

The gateway authenticates requests, refuses redirects, bounds concurrency and payloads, and does not log requests, prompts or credentials. Its health endpoint checks gateway liveness, not upstream model availability. Its socket and response-read deadlines bound stalled calls; a blocking upstream read can extend beyond the nominal overall deadline by one socket timeout.

For experimental English instructions, set `PROMPT_LANGUAGE=en` and mount an explicitly trusted Python catalog read-only at `PROMPT_CATALOG_PATH`. The catalog implements `transform(body, language)` returning `(body, metadata)`; metadata is discarded. This is executable operator code, not an uploaded character card. The gateway does not install or fetch a catalog. The evaluated catalog translates recognized chat, affinity evaluation and affinity summary prompts; unknown branches and character/history content remain unchanged. An English persona alone does not translate the engine's native prompts. Keep the exact catalog file available across restarts and validate its coverage when upgrading Eros.

Offline gateway checks:

```sh
python3 -B -m unittest discover -s infra/companion -p test_model_gateway.py
```

## Character and engine debugging

Eros bot settings show native character insights, relationship axes and tiers, the latest evaluation changes, and the current emotional need. These reads use the existing story/session binding; opening settings never creates another conversation. Send the first message before inspecting a new bot. Use Refresh after a reply: Eros can finish its affinity and feeling processing after delivering the text.

The optional debug bridge adds the full deployed character instructions, personality guidance, timezone, and the **saved feeling summary** with its timestamp. Emotional need and the saved feeling are separate fields. A missing summary means Eros has not saved one; the UI does not invent it. Persona fields are read-only because genomes can be shared by many conversations.

With the bridge enabled, explicit debug edits change native trust, intrigue, intimacy and tension (0–1), plus warmth and patience grades (1–3). Displayed warmth/patience scores and bond/chemistry tiers come from Eros's native calculation. Edits clear the old feeling summary; a later native evaluation may produce a new one. Existing native events are retained. Persisted derived projection columns are left for native processing to refresh; consumers should use the native affinity API rather than those cached columns.

The **Time** panel shows the native database clock in the effective character timezone and elapsed relationship/feeling time. Its optional 0–720 hour simulation backdates only the current session’s affinity timestamp, so Eros applies its own decay calculation. It does not move the engine wall clock, rewrite message dates, or change a shared genome’s timezone. A time edit clears the old feeling and retains a real-time summary fence; backdating cannot bypass the quiet period.

Editable fields remain visible during temporary processing, with a reason for the block. The panel refreshes while processing or settling and after a reply ends. Drafts retain their original revision; if the engine changes underneath an edit, discard the draft to load the latest values before editing again.

Saving requires the same conversation generation and an unchanged engine revision. Active local work, unresolved deliveries, native queued work and recent native processing block edits. The bridge waits for a 30-second quiet period and evidence that the latest ordinary turn settled. An unacknowledged failed turn can require a new successfully settled turn before editing is available. Older failed turns do not permanently block later settled ones. Refresh after conflicts or an unconfirmed save; the client does not automatically repeat writes.

### Native controls and observations

Bot settings cover eight areas: needs, relationship evolution, what the character has learned about the user, current events, inventory/outfit, initiative, behavior guidance, and model generation configuration. Native needs, profiles and events are observations, not invented editable scores. Missing needs or insights can mean the corresponding native evaluation/extraction task is not configured. The relationship user profile is a recorded per-instance projection; the memory-context selector separately controls context injection and does not disable extraction writes.

Per-bot controls include prompt traits (up to eight short single-line instructions), native memory and affinity scopes, outfit and a deployment-defined generation profile (`tier`). They are stored encrypted with revision checks. A turn snapshots these settings before its first external request; later setting changes do not alter recovery of an accepted turn. Existing ledger rows without a snapshot retain their legacy defaults. Scope settings affect prompt context, not the native extraction pipeline or arbitrary numerical progression rules.

The generation panel can show selected model, fallback, temperature and token limits from an operator-owned configuration projection. These are service-wide boot settings, not per-bot sampling overrides. The optional bridge needs Python 3.11+ to parse its read-only TOML mount; it exports no provider URLs, headers, keys or prompts. An unavailable projection leaves native conversation controls operational. Editing that TOML requires an operator restart of Eros; displayed configuration is not a live reload acknowledgement.

Explicit buttons invoke native greetings, event draws and inventory add/remove operations. Event kinds filter a native draw rather than guarantee a specific event, and a successful call can generate no message. Greetings can explicitly initialize a new conversation. Preset inventory entries cannot be deleted for one instance. Generated replies are imported into the Rakazo chat, with native message identity deduplication.

Every action is recorded before network I/O with its immutable request/settings. Completed outcomes, including empty outcomes, are replayed locally. The browser retains an outstanding action ID across a lost response and offers Check action using that same ID; it does not generate a new retry ID. Definitively rejected requests can be corrected and resubmitted. An ambiguous native mutation is retained as uncertain and blocks further engine work until operator reconciliation; checking it reports its recorded status and never blindly reruns it. This is especially necessary for inventory POST, which has no native idempotency key. Local records and request/response JSON are tenant-scoped and encrypted.

Apply both additive conversation-engine settings/action migrations before deploying the updated API and workers. The migration runner grants the existing restricted runtime role access to the new table. The Eros service database and its existing role policies are unchanged by these Rakazo migrations.

### Enable the optional bridge

This bridge is original integration code against the pinned Eros schema, not a general database API. Revalidate its SQL and grants when upgrading Eros. It uses a separate database login with column grants and scoped row policies, dedicated authentication, and short-lived signed user/session/instance/character claims. Clients cannot choose upstream identities or service URLs. It cannot read message text or edit shared personas. Only the Rakazo backend receives its credentials.

1. Generate independent URL-safe `DEBUG_DATABASE_PASSWORD` and `DEBUG_BRIDGE_SECRET` values in the private companion environment. Set `COMPANION_DEBUG_IMAGE` to an already installed image with Node 18 or later. No image is downloaded by this recipe.
2. Apply [`debug-bridge-role.sql`](../infra/companion/debug-bridge-role.sql) as the companion database administrator, providing its `debug_password` psql variable privately. This grants the dedicated role access; it does not grant Rakazo direct database access.
3. Run `node scripts/build-companion-debug.mjs`. This bundles the bridge with dependencies already installed in the repository into the ignored `.cache/companion` directory.
4. Include [`docker-compose.debug.yml`](../infra/companion/docker-compose.debug.yml) alongside the base file and any local model gateway override, then run `up -d debug-bridge`.
5. Add `"debugBridge":{"baseUrl":"http://127.0.0.1:5186","secret":"<dedicated-debug-bridge-secret>"}` to the existing Eros entry in `CONVERSATION_ENGINES`. Restart the Rakazo API and workers. Containerized APIs on the companion service network use `http://companion-debug:8082` instead.

The bridge publishes only loopback port 5186 and runs without root, writable root filesystems or Linux capabilities. It joins the database and service networks; PostgreSQL remains unpublished. The base Eros engine remains operational without the bridge. Configured-but-unreachable debugging reports an error instead of silently presenting stale or fabricated values. Keep all private environment and local override files out of version control.

## Turn lifecycle and retention

Each Rakazo story/history generation gets a persisted random Eros user UUID and external session binding, separate from real account IDs. Eros has user-global memories shared across personas; this synthetic identity boundary prevents sharing between Rakazo stories. The adapter's default memory scope remains Eros's native `neutral_and_relationship` injection setting. Scope controls do not disable memory writes.

Rakazo persists an immutable request and UUID `client_msg_id` before sending a turn. Eros deduplicates that key permanently for the session. After a disconnect or worker restart, Rakazo reuses the same ID to recover the reply before submitting another turn. A duplicate still generating remains pending; a terminally failed duplicate cannot be regenerated under that same ID. An unavailable service causes a clear failure/pending result instead of falling back to the internal runtime.

**Stop stops Rakazo delivery; it does not cancel an accepted Eros turn.** Eros continues generation and may save the reply and update memories after its connection closes. The next message first reconciles unfinished external work. Local replies are buffered until an authoritative final event, so superseded upstream output is not committed as the answer. Silent, truncated and incomplete turns are not reported as successful empty messages. A final reply does not acknowledge completion of Eros's asynchronous memory/affinity processing; the native protocol has no such completion endpoint.

Clearing history is unavailable for Eros conversations because it would leave the external engine's context intact. Create a separate bot/story for a separate conversation. Hard deletion of Eros bots, and accounts or spaces containing them, is rejected before teardown until operator cleanup is available. Archiving remains available and does **not** erase the external service's stored data. Operators must manage external retention, encrypted backups and erasure separately. Eros's optional user-erasure endpoint removes derived knowledge but explicitly retains chat sessions/messages and numerical relationship state; it also requires traffic to quiesce so in-flight extraction cannot repopulate data. Archive and `force_new` are not erasure operations. This integration does not claim complete upstream deletion.

The companion database survives `companion down` and ordinary engine restarts. Back it up independently before migrations or upgrades and test restoration with the matching pinned service. Do not use `down --volumes` for a normal stop: removing that dedicated volume destroys the service's durable conversation state. Keep Rakazo's persisted session/turn bindings alongside companion backups; independently restoring one system can leave them out of sync.

Eros is an independently deployed AGPL-3.0-only service; Rakazo's adapter contains original HTTP integration code and no embedded upstream source. The upstream image, native configuration examples and modifications retain their own licensing obligations. Use the pinned upstream source/license when preparing a deployment or distributing a modified service.

## Verification of the first integration

Deterministic tests cover the HTTP protocol, character admission, safe catalog projection, tenant isolation, encrypted turn persistence, lease contention, replay after interruption and Stop, and deletion preflight. PostgreSQL regression tests also cover the existing internal roleplay and account-deletion paths. A real two-turn Eros trial exercised the Rakazo executor with a synthetic owner: both turns completed, each saved one reply, and a fresh executor reused the persisted session without invoking local roleplay context or computer capabilities. This is an orchestration check, not a calibrated conversation-quality evaluation.

The web creation selector was checked in desktop and mobile viewports with a synthetic catalog. The separate persistent Compose recipe also passed a real synthetic chat through the optional gateway and resumed the same session after an engine restart. This verifies chat routing and session persistence, not embedding availability or long-term memory extraction.
