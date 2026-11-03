#!/usr/bin/env bash
# Run on one origin at a time as root. This rolls application images/configuration back, never schema.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 2
exec 9>/opt/rakazo/deploy.lock
flock -n 9 || { echo "A deployment is running." >&2; exit 1; }
[[ ! -e /opt/rakazo/maintenance ]] || { echo "The origin is in maintenance." >&2; exit 1; }
previous=$(readlink -f /opt/rakazo/previous)
[[ "$previous" == /opt/rakazo/releases/release-* && -f "$previous/compose.yml" ]] || exit 2
cd "$previous"
compose() { docker compose --project-name rakazo --env-file .env -f compose.yml "$@"; }
compose stop cloudflared
compose up -d --wait --wait-timeout 240 data-init api worker web
compose up -d cloudflared
ln -sfn "$previous" /opt/rakazo/current
echo "Previous application release restored. The database schema was not reverted."
