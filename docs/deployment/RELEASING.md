# Releasing wunderland

Releases are automated. Every push to `master` runs the [publish workflow](https://github.com/jddunn/wunderland/blob/master/.github/workflows/publish.yml), which decides from the commit subjects whether a new version goes to npm. Nobody publishes by hand.

## What a push to master runs

The workflow skips the job when the pushed commit's message contains `[skip ci]`; the version commits it pushes itself carry that mark. Otherwise it runs on Node 22 with pnpm 10:

1. **Gates.** `pnpm install --no-frozen-lockfile`, `pnpm build`, the unit tests (`pnpm exec vitest run`), the integration tests (`pnpm run test:integration`), the quarantined tests and `node scripts/smoke-dist.mjs`, which loads the built package under plain Node. A quarantined file's failures do not block; a quarantined test that used to pass and no longer does, does. A failing gate stops the run before anything is versioned or published.
2. **Version.** The job reads the subjects of the commits since the latest tag reachable from the pushed commit (merge commits left out) and takes the highest bump any subject asks for:

| Commit subject | Bump while the version is 0.x | Bump from 1.0.0 on |
|---|---|---|
| `!` before the colon (`feat!:`, `fix(cli)!:`), or the words "breaking change" anywhere, in any case, joined by a space, `-` or `_` | minor | major |
| `feat:` or `feat(<scope>):` | minor | minor |
| `fix`, `perf` or `refactor`, with or without a scope | patch | patch |
| any other subject (`docs`, `chore`, `ci`, `test`, `build`, `style`, `revert`) | none | none |

   The job reads subjects only, so a `BREAKING CHANGE:` footer in a commit body does not count. The new version starts from the higher of the version in `package.json` and the latest version on npm.
3. **Pack and check.** When a bump is due, the job sets the version in `package.json` and commits it locally as `chore(release): v<version> [skip ci]`, replaces `workspace:` ranges with `*`, packs the tarball with `pnpm pack`, installs that tarball into an empty project, checks that `wunderland --version` prints the new version, and smokes the installed package.
4. **Publish.** On `master`, and not in a dry run, it publishes the checked tarball to npm with the repository secret `NPM_TOKEN`, starts the [post-publish canary](https://github.com/jddunn/wunderland/blob/master/.github/workflows/post-publish-canary.yml), then pushes the version commit to `master`, rebasing it when `master` moved during the run.
5. **Tag and release.** A second job, which runs whenever the version reached npm, tags the commit the run started from as `v<version>` and creates the GitHub release. Its notes list the commit subjects since the previous tag, without the `[skip ci]` commits.
6. **Canary.** The canary installs the published version from npm on a clean runner, checks `wunderland --version` and runs the smoke script against the installed package. When it fails, it opens an issue.

The workflow does not write `CHANGELOG.md`; each version's notes are on its [GitHub release](https://github.com/jddunn/wunderland/releases).

## The pull request title

Maintainers squash-merge with the pull request title as the commit subject and an empty body, so the title is what the version rule reads.

- A change that breaks users needs `!` before the colon in the title. A `BREAKING CHANGE:` footer typed into the merge box is not read.
- The words "breaking change" anywhere in a title mark it as breaking, so use them only for one.
- A `docs:`, `chore:`, `ci:` or `test:` title releases nothing; the push runs the gates.

## When a release fails

- **A gate fails:** nothing is versioned or published and `master` is unchanged. Fix the cause; the next push runs the release again over the same commits.
- **`npm publish` fails:** the version commit is not pushed and no tag is made. The next push to `master` computes the version again from the same tag and publishes it, newer commits included.
- **The version commit cannot be pushed after the publish:** the run fails; npm has the version and `master` does not. The second job creates the tag and the release regardless, and the next release counts from the version npm holds.
- **The canary cannot be started:** the run fails after the push, and its log gives the command to start the canary by hand.

## Dry runs

Maintainers can start the workflow by hand from the Actions tab. A manual run is a dry run unless the `dry_run` box is cleared: it runs every gate, the pack and the clean install, and publishes and pushes nothing. A manual run on a ref other than `master` never publishes.

## Rules

- Never edit the `version` field in `package.json` to release, never run `npm publish` or `pnpm run release`, and never create a `v` tag by hand.
- A change to the release steps goes through a pull request reviewed by a maintainer.
