#!/usr/bin/env bash
set -euo pipefail

# A terminal-friendly entrypoint for the existing local stack, including Finder on macOS.
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_root"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf 'Usage: ./start.command\nStarts the existing local stack. Keep this terminal open; Ctrl+C stops it.\n'
  exit 0
fi
if (( $# > 0 )); then
  printf 'Usage: ./start.command\n' >&2
  exit 2
fi

resolve_tool() {
  local name="$1" candidate
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  # Finder may omit the directories already available in an interactive terminal.
  for candidate in "/opt/homebrew/bin/$name" "/usr/local/bin/$name" \
    "$HOME/.volta/bin/$name" "$HOME/.local/share/fnm/aliases/default/bin/$name" \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/"$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

node_binary="$(resolve_tool node)" || {
  printf 'Node.js is required. Install a version supported by package.json, then retry.\n' >&2
  exit 1
}
export PATH="$(dirname -- "$node_binary"):$project_root/node_modules/.bin:$PATH"

if [[ ! -d node_modules ]]; then
  printf 'Install the project dependencies before starting the stack.\n' >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required. Install the version declared in package.json, then retry.\n' >&2
  exit 1
fi

exec make start
