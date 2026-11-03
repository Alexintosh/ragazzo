#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
terraform_bin=${TERRAFORM_BIN:-terraform}
"$terraform_bin" fmt -check -recursive "$root"
for directory in terraform compute; do
  "$terraform_bin" -chdir="$root/$directory" init -backend=false -input=false -lockfile=readonly
  "$terraform_bin" -chdir="$root/$directory" validate
  # Tests use mock providers; no credentials, plan against a live account, or apply.
  "$terraform_bin" -chdir="$root/$directory" test -no-color
done
node --test "$root"/scripts/*.test.mjs
for script in "$root"/scripts/*.sh; do bash -n "$script"; done
