# bun-lock-submission

GitHub's dependency graph does not read `bun.lock`. In a Bun project it only sees the versions written in each `package.json`, so Dependabot alerts miss every transitive dependency, and every dependency declared with `catalog:`.

bun-lock-submission reads `bun.lock` and submits the resolved dependency tree through GitHub's [dependency submission API](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/use-dependency-submission-api). Dependabot then raises alerts for those dependencies, the way it does for `package-lock.json`.

It comes as a GitHub Action and as a CLI.

## GitHub Action

```yaml
# .github/workflows/dependency-submission.yml
name: Dependency submission

on:
  push:
    branches: [main]
    paths:
      - '**/bun.lock'
      # Editing this workflow, such as its inputs or the action version, changes
      # what gets submitted too.
      - .github/workflows/dependency-submission.yml
  workflow_dispatch:

permissions: {}

jobs:
  submit:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v7
      - uses: charpeni/bun-lock-submission@v1
```

The action submits every `bun.lock` in the repository, outside `node_modules`, in a single snapshot. Dependabot alerts follow the default branch, so run it on pushes to that branch. Pin the action to a commit SHA if your repository requires it.

A submission stays in place until the next one replaces it, so commits that leave the lockfiles alone keep their alerts. The first push to a new repository does not run a workflow filtered by `paths`, so run it once from the Actions tab.

| Input                | Default               | Description                                                                                                                                                                            |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working-directory`  | `.`                   | Directory to search for `bun.lock` files.                                                                                                                                              |
| `lockfiles`          | every `bun.lock`      | Lockfiles to submit, one per line, relative to `working-directory`.                                                                                                                    |
| `layout`             | `lockfile`            | `lockfile` reports dependencies against each `bun.lock`. `workspaces` reports them against each workspace `package.json`. See [Avoiding duplicate alerts](#avoiding-duplicate-alerts). |
| `include-exact-pins` | `false`               | Also submit direct dependencies that `package.json` pins to the locked version.                                                                                                        |
| `exclude`            |                       | Package names to leave out, one per line or comma-separated. `*` matches any characters.                                                                                               |
| `correlator`         | `bun-lock-submission` | Snapshot group. Each submission replaces the previous one with the same correlator, so give each step that submits a different set of lockfiles its own value.                         |
| `token`              | `github.token`        | Needs the `contents: write` permission.                                                                                                                                                |
| `dry-run`            | `false`               | Write the snapshot to a file instead of submitting it.                                                                                                                                 |

| Output          | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `result`        | GitHub's answer: `SUCCESS` or `ACCEPTED`. `DRY_RUN` in a dry run. |
| `snapshot-id`   | The ID of the submitted snapshot.                                 |
| `manifests`     | How many manifests the snapshot contains.                         |
| `packages`      | How many packages were submitted, counted once per lockfile.      |
| `snapshot-path` | In a dry run, the path of the snapshot file.                      |

## CLI

```sh
bunx bun-lock-submission snapshot   # print the snapshot as JSON
bunx bun-lock-submission submit     # submit it to GitHub
bunx bun-lock-submission clear      # remove what was submitted
```

`npx bun-lock-submission` works too. The CLI reads the commit, ref and repository from git, and the token from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. It takes the same options as the action. Run `bunx bun-lock-submission --help` for the list.

## What gets submitted

Every package installed from a registry, at its locked version. The lockfile is read the way Bun installs it: nested copies, `npm:` aliases (reported under the real package name), and the dependencies of `workspace:`, `file:`, `link:` and git packages. Those packages themselves have no npm identity, so they are left out.

A package is direct when a workspace `package.json` declares that version, and transitive otherwise. It is a development dependency when every path to it starts from a workspace's `devDependencies`, and a runtime dependency otherwise. Each workspace counts as a package of its own, so its `dependencies` are runtime even when another workspace only uses it as a dev dependency. Optional peers do not count as a path: a package installed only because it is a dev dependency stays a development dependency, even when a runtime package lists it as an optional peer.

Text lockfiles up to `lockfileVersion` 3 are supported. The legacy binary `bun.lockb` is not; run `bun install --save-text-lockfile` to write `bun.lock`.

## Avoiding duplicate alerts

GitHub still analyzes each `package.json` on its own. When a `package.json` pins a dependency to an exact version, like `"zod": "3.25.76"`, GitHub already raises its alerts there. Submitting it again from `bun.lock` would give it a second alert.

So by default the `lockfile` layout leaves out direct dependencies that every `package.json` pins to exactly the locked version, in `dependencies`, `devDependencies` or `optionalDependencies`. Everything GitHub cannot match is still submitted: ranges, which GitHub checks against the declared range rather than the locked version, `catalog:`, `workspace:` and `npm:` aliases, and anything in `peerDependencies`, which GitHub's analysis does not read.

The `workspaces` layout takes the other route. It submits one manifest per workspace `package.json`, which replaces GitHub's own analysis of that file. Direct dependencies go in their workspace's manifest, and transitive dependencies go in the root `package.json`. If a workspace also has its own, stale `bun.lock`, both lockfiles would describe the same `package.json`, so the submission fails and asks you to list the lockfiles to submit.

## Good to know

- Dependabot alerts work, but Dependabot does not open security update pull requests for Bun projects.
- Each submission replaces the previous one with the same correlator. When a lockfile is missing from the next submission, its alerts close as fixed. If it comes back, the alerts reopen, but dismissals are lost.
- A snapshot for a branch other than the default one comes back as `ACCEPTED`: GitHub stores it, but it does not raise alerts. On a pull request from the same repository, the action reports the pull request's head branch. On a pull request from a fork, it keeps the merge ref, so a fork's `main` cannot replace yours.
- GitHub ignores a snapshot older than the latest one for its correlator, so a delayed run cannot overwrite a newer one.
- GitHub matches advisories by package name. A private package that shares its name with a public one would get that package's alerts, so leave private packages out with `exclude`.
- The dependency graph must be enabled. It is by default on public repositories.
- To remove everything that was submitted, run `bunx bun-lock-submission clear`, with `--correlator` if you changed it.

## Development

```sh
bun install
bun run check   # Oxfmt, Oxlint, TypeScript and tests
bun run build   # bundles the CLI and the action
```

GitHub runs the action from `packages/action/dist`, so commit the rebuilt bundle with any change to `packages/core` or `packages/action`.

The tests check the lockfile reader against real projects in `packages/core/fixtures/projects`: single packages and workspaces, written by Bun 1.1 to 1.4 in every lockfile version. Each fixture keeps the `bun.lock` that Bun wrote and an `installed.json` that records what Bun actually installed, read from `node_modules`. To add a setup, add a template and a fixture, then run `bun packages/core/scripts/generate-fixtures.ts`, which needs network access.

### Releasing

The CLI and the action are released separately. To release the CLI, bump `version` in `packages/cli/package.json` and push a `cli-vX.Y.Z` tag on `main`: the Publish CLI workflow publishes it to npm through trusted publishing. To release the action, bump `version` in `packages/action/package.json`, which is the detector version GitHub records, rebuild the bundle, and push a `vX.Y.Z` tag on `main`. Then publish a GitHub release for that tag to GitHub Marketplace, and move the `vX` tag to it.

## License

[MIT](./LICENSE)
