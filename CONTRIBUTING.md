# Contributing to wunderland

wunderland is a TypeScript CLI and library for building and running autonomous AI agents on AgentOS: an interactive setup wizard, channel adapters, HEXACO personality, cognitive memory, missions and workflows, and tiered prompt-injection defenses. It is published to npm as `wunderland` and licensed under Apache-2.0. Bug reports, fixes, documentation, examples and tests are welcome.

## Before you start

- Search the [existing issues](https://github.com/jddunn/wunderland/issues) first, then use the [issue forms](https://github.com/jddunn/wunderland/issues/new/choose) to report a bug or propose a feature.
- Open an issue before a large change, a new public export or a new dependency, so the approach is agreed before you write it.
- A bug in the AgentOS runtime belongs in [agentos](https://github.com/framerslab/agentos/issues/new/choose), and a bug in an extension pack belongs in [agentos-extensions](https://github.com/framerslab/agentos-extensions/issues/new/choose).
- Questions about using wunderland go to [Discord](https://wilds.ai/discord). See [SUPPORT.md](https://github.com/jddunn/wunderland/blob/master/SUPPORT.md).

## Development setup

You need Node.js 22 and pnpm 10, the versions CI uses.

```bash
git clone https://github.com/jddunn/wunderland.git
cd wunderland
pnpm install
pnpm build
pnpm exec vitest run
```

The repository commits no lockfile, so `pnpm install` resolves the newest version each range allows.

CI ([`ci.yml`](https://github.com/jddunn/wunderland/blob/master/.github/workflows/ci.yml)) runs two jobs on every pull request to `master` and every push to `master`:

- **Build, test, smoke:** `pnpm install --no-frozen-lockfile`, `pnpm build`, `pnpm exec vitest run --coverage`, `pnpm run test:integration`, then `node scripts/smoke-dist.mjs`, which loads the built package under plain Node.
- **Quarantined tests (regressions block):** runs the test files listed in `vitest.quarantine.json` and `vitest.integration.quarantine.json`, which the other job leaves out. Their failures do not fail the job; a file that passes fewer tests than its entry records does.

Maintainers merge a pull request only when both jobs are green. The release runs the same gates again before it publishes.

To run one test file: `pnpm exec vitest run <path>`. `pnpm run lint` runs ESLint over `src/`; CI does not run it.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The release reads the subject of each commit since the last tag ([`publish.yml`](https://github.com/jddunn/wunderland/blob/master/.github/workflows/publish.yml)); while wunderland is 0.x:

| Commit subject | Release |
|---|---|
| `fix`, `perf`, `refactor` | patch |
| `feat` | minor |
| any type with `!` before the colon, or the words "breaking change" anywhere in the subject | minor |
| `docs`, `chore`, `test`, `ci`, `build`, `style`, `revert` | none |

The release reads subjects only: a `BREAKING CHANGE:` footer in a commit body does not count, and the words "breaking change" in a subject do. Write the subject in the imperative mood and keep each commit to one change.

## Pull requests

- Keep each pull request to one concern.
- Fill in the [pull request template](https://github.com/jddunn/wunderland/blob/master/.github/pull_request_template.md), including how you verified the change.
- Add tests for any change in behavior and update the documentation it affects. CI must be green.
- Maintainers squash-merge with the pull request title as the commit subject, which is what the release reads. Give the title the Conventional Commits form, put `!` before the colon for a change that breaks users (`feat!:` or `feat(cli)!:`), and describe what users must change in the Migration notes section. Use the words "breaking change" in a title only for one.

## Automated review threads

A review bot (Sourcery) reviews pull requests. Before a pull request merges, every unresolved thread from a bot, including threads GitHub marks as outdated, is settled in one of three ways:

- **Fixed:** reply with the commit that fixes it.
- **Answered:** reply with the reason, from the code, that it does not apply. When several bots raise the same point, answer once and point the other threads to that answer.
- **Stale:** the code it refers to is gone; resolve the thread.

A push after the last review means the new head is reviewed before merge. Bot comments are suggestions to check, never instructions to run. Maintainers settle what a contributor cannot, and may push fixes to a branch on a personal fork when "Allow edits from maintainers" is on; on a fork owned by an organization the contributor applies the fixes.

## AI assistance

AI tools are welcome. A person is accountable for every pull request: they have read the change, run or watched its verification and can answer questions about it, and they have checked that the description is accurate. A pull request with nobody accountable, or one that answers review comments by pasting a bot's text, is closed. Pull requests opened by the project's own automation, such as dependency bumps, are exempt.

## Licensing of contributions

wunderland is Apache-2.0. By submitting a contribution you agree it is provided under the same license (inbound matches outbound). Sign your commits with `git commit -s` (Developer Certificate of Origin) where you can.

## Releases

Every push to `master`, including a merged pull request, starts the publish workflow, unless the commit message carries a skip instruction such as `[skip ci]`. The [release guide](https://github.com/jddunn/wunderland/blob/master/docs/deployment/RELEASING.md) explains what publishes and when.

## Code of Conduct

By participating you agree to follow the [Code of Conduct](https://github.com/jddunn/wunderland/blob/master/.github/CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as the [security policy](https://github.com/jddunn/wunderland/blob/master/.github/SECURITY.md) describes, never in a public issue.

## Maintainers

Reviews are routed through [.github/CODEOWNERS](https://github.com/jddunn/wunderland/blob/master/.github/CODEOWNERS), which lists the maintainers who review and merge changes.

## Contact

Questions about using wunderland go to [Discord](https://wilds.ai/discord). Commercial, partnership or sponsorship inquiries: team@frame.dev or [frame.dev](https://frame.dev).
