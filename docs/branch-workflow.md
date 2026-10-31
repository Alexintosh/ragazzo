# Branch workflow

| Branch / remote | Purpose |
| --- | --- |
| `upstream` | Original Rakazo repository, used to fetch updates. |
| `main` | Tracks `upstream/main`; keep free of local feature commits. |
| `develop` | Integration branch for local changes, including the internal RP implementation. |
| `feat/*` | Scoped work started from `develop` and merged back after verification. |
| `feat/roleplay-bots` | Preserved Eros integration and experiments, deferred for later. |
| `feat/rp-internal` | Preserved pre-Eros starting point used to create `develop`. |

No `origin` is configured. Adding a remote for publishing this fork is a separate decision. Do not push or create worktrees without explicit authorization.

## Local feature work

Start with a clean working tree, in the existing checkout:

```sh
git switch develop
git switch -c feat/example
```

After implementing, reviewing and testing the change:

```sh
git switch develop
git merge --no-ff feat/example
```

## Upstream updates

Update the upstream mirror with a clean working tree:

```sh
git switch main
git pull --ff-only upstream main
git switch develop
```

The local development history began as a source snapshot without the original Git ancestry. It therefore has no common ancestor with upstream. Updating `main` does not update `develop`, and a normal merge from `main` into `develop` is not currently the integration path.

For selected upstream fixes, create a branch from `develop`, inspect the commits and their dependencies, and cherry-pick the required commits in order. Resolve conflicts and run the relevant checks before merging into `develop`. Do not record an upstream merge that discards its changes merely to connect the histories. A full ancestry reconciliation requires a separate, deliberate migration.

Eros integration starts at commit `073a78d`; `develop` was created from its parent, `58e3e13`. The earlier RP implementation and research documents are retained, while the Eros integration remains on `feat/roleplay-bots`.
