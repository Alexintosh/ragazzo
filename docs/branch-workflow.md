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

Updating `main` does not update `develop`. Integrate upstream changes on a feature branch so conflicts and behavior can be reviewed before updating the integration branch:

```sh
git switch -c chore/upstream-update develop
git merge --no-ff main
```

Resolve conflicts while preserving local features, run the relevant checks, and merge the verified branch into `develop`. Selected fixes can also be cherry-picked with their required dependencies. Do not resolve an upstream merge by discarding its changes wholesale.

### Imported snapshot ancestry

The original local history began as a source snapshot without Git ancestry. Its upstream source was identified as `9634e064b5ed7fb8f5f4e583fbb8fa10536140c6`: the snapshot includes that commit's desktop UTF-8 fix and its parent's CJK fix, retains the versions preceding the next commits, and exactly matches the source lockfile and unchanged configuration trees. It was the unique nearest tree among the upstream candidates examined.

An ancestry-only merge recorded that original import base without changing local source files. A subsequent real merge integrated the later upstream changes. This preserves the original local commits and gives future upstream merges a shared ancestor; it does not treat later upstream changes as already incorporated merely by connecting histories.

Eros integration starts at commit `073a78d`; `develop` was created from its parent, `58e3e13`. The earlier RP implementation and research documents are retained, while the Eros integration remains on `feat/roleplay-bots`.
