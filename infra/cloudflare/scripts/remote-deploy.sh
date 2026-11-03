#!/usr/bin/env bash
set -euo pipefail
umask 077
release=${1:?Missing release}
mode=${2:?Missing mode}
[[ "$release" =~ ^release-[0-9]+-[a-f0-9]{8}$ ]] || exit 2
[[ "$mode" == migrate || "$mode" == serve ]] || exit 2
[[ $(id -u) == 0 ]] || { echo "Deploy through a root SSH account." >&2; exit 2; }
exec 9>/opt/rakazo/deploy.lock
flock -n 9 || { echo "Another deployment is running on this host." >&2; exit 1; }
[[ ! -e /opt/rakazo/maintenance ]] || { echo "This host is in backup/maintenance mode." >&2; exit 1; }
directory=/opt/rakazo/releases/$release
cd "$directory"
trap 'rm -f "$directory/migration.env"' EXIT
# env_file.format=raw is needed to preserve secret characters without interpolation.
compose_version=$(docker compose version --short | sed 's/^v//')
[[ $(printf '%s\n' 2.30.0 "$compose_version" | sort -V | head -1) == 2.30.0 ]] || {
  echo "Docker Compose >=2.30.0 is required." >&2; exit 1;
}
compose() { docker compose --project-name rakazo --env-file .env -f compose.yml "$@"; }
chmod 600 .env api.env worker.env web.env tunnel-token
compose config --quiet
compose pull api worker web cloudflared data-init
if [[ "$mode" == migrate ]]; then
  [[ -s migration.env ]] || { echo "Migration credentials are missing." >&2; exit 1; }
  compose run --rm --no-deps migrate
  rm -f migration.env
fi
chmod 644 database-check.mjs
compose run --rm --no-deps -v "$directory/database-check.mjs:/app/database-check.mjs:ro" api node /app/database-check.mjs

# Drain this origin from Tunnel before restarting processes. Other replicas keep serving.
# One origin means a maintenance interruption; existing streams may reconnect on every rollout.
previous=$(readlink -f /opt/rakazo/current 2>/dev/null || true)
if [[ -n "$previous" && "$previous" != "$directory" ]]; then
  ln -sfn "$previous" /opt/rakazo/previous
fi
compose stop cloudflared
if ! compose up -d --wait --wait-timeout 240 data-init api worker web; then
  echo "New release failed health checks. This origin remains disconnected." >&2
  echo "Previous configuration retained at: ${previous:-none}" >&2
  exit 1
fi
compose up -d cloudflared
ln -sfn "$directory" /opt/rakazo/current
echo "Origin updated and locally healthy."
