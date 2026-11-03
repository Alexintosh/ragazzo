#!/usr/bin/env bash
# Populate the shared archive with the new image's immutable files before any origin upgrades.
set -euo pipefail
umask 077
release=${1:?Missing release}
[[ "$release" =~ ^release-[0-9]+-[a-f0-9]{8}$ ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
exec 9>/opt/rakazo/deploy.lock
flock -n 9
[[ ! -e /opt/rakazo/maintenance ]] || exit 1
cd "/opt/rakazo/releases/$release"
compose() { docker compose --project-name rakazo --env-file .env -f compose.yml "$@"; }
compose config --quiet
compose pull web data-init
compose run --rm --no-deps data-init
# Reuse the application's manifest/retention logic; Node 24 runs its source TypeScript.
chmod 644 stage-assets.mjs
compose run --rm --no-deps -v "$PWD/stage-assets.mjs:/app/apps/web/stage-assets.mjs:ro" \
  --entrypoint node web stage-assets.mjs
