#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
image=${1:?Usage: build-image.sh registry/your-fork/app:release-tag [--push]}
[[ "$image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]+:[a-zA-Z0-9._-]+$ ]] || { echo "Invalid image tag" >&2; exit 2; }
[[ "${2:-}" == "" || "${2:-}" == --push ]] || exit 2
publish=(--load)
if [[ "${2:-}" == --push ]]; then publish=(--push); fi
docker buildx build --platform linux/amd64 --file "$root/infra/compose/Dockerfile" \
  --build-arg "GIT_SHA=$(git -C "$root" rev-parse HEAD)" --tag "$image" "${publish[@]}" "$root"
echo "Build complete. After publishing, use the registry manifest digest (not a local image ID) for deployment."
