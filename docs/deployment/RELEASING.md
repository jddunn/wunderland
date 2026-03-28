# Releasing Packages

This document describes how to release packages from the voice-chat-assistant monorepo.

---

## Package Release Locations

| Package                      | npm                                                           | Release Location                                                                          |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| @framers/agentos             | [npm](https://npmjs.com/package/@framers/agentos)             | [framersai/agentos](https://github.com/framersai/agentos/actions/workflows/release.yml)   |
| @framers/sql-storage-adapter | [npm](https://npmjs.com/package/@framers/sql-storage-adapter) | [framersai/sql-storage-adapter](https://github.com/framersai/sql-storage-adapter/actions) |

---

## @framers/agentos

### Release Process

Releases are **manual only** — no automatic version bumps on commits.

#### Steps

1. **Ensure code is ready**

   ```bash
   cd packages/agentos
   pnpm test
   pnpm build
   ```

2. **Update CHANGELOG.md** with release notes

3. **Push changes to standalone repo**

   ```bash
   cd packages/agentos
   git add -A
   git commit -m "feat: your changes"
   git push origin master
   ```

4. **Trigger release workflow**
   - Go to [framersai/agentos Actions](https://github.com/framersai/agentos/actions/workflows/release.yml)
   - Click **"Run workflow"**
   - Enter version (e.g., `0.2.0`)
   - Click **"Run workflow"**

5. **Verify release**
   - Check [npm](https://npmjs.com/package/@framers/agentos)
   - Check [GitHub Releases](https://github.com/framersai/agentos/releases)

### Version Guidelines

| Change          | Bump  | Example       |
| --------------- | ----- | ------------- |
| Bug fix         | PATCH | 0.1.0 → 0.1.1 |
| New feature     | MINOR | 0.1.1 → 0.2.0 |
| Breaking change | MAJOR | 0.2.0 → 1.0.0 |

### Why Manual Releases?

- **Prevents accidental bumps** — No surprise version increments
- **Deliberate releases** — Each release is intentional and tested
- **Control over versioning** — You decide when to bump major/minor/patch

---

## @framers/sql-storage-adapter

Same process — use the [sql-storage-adapter repo](https://github.com/framersai/sql-storage-adapter) for releases.

---

## Submodule Workflow

The monorepo uses git submodules for packages that are also standalone repos:

```
voice-chat-assistant/
├── packages/
│   ├── agentos/          → github.com/framersai/agentos
│   └── sql-storage-adapter/ → github.com/framersai/sql-storage-adapter
└── apps/
    ├── agentos.sh/       → github.com/framersai/agentos.sh
    └── agentos-workbench/ → github.com/framersai/agentos-workbench
```

### Updating Submodules

```bash
# Pull latest for all submodules
git submodule update --remote

# Or update specific submodule
cd packages/agentos
git pull origin master
cd ../..
git add packages/agentos
git commit -m "chore: update agentos submodule"
```

### Pushing Changes

Always commit to the submodule repo first:

```bash
# 1. Commit in submodule
cd packages/agentos
git add -A
git commit -m "feat: new feature"
git push origin master

# 2. Update monorepo reference
cd ../..
git add packages/agentos
git commit -m "chore: update agentos submodule"
git push origin master
```

---

## Troubleshooting

### "npm publish" fails with 401

- Ensure `NPM_TOKEN` secret is set in the standalone repo settings

### Version already exists on npm

- npm doesn't allow republishing. Increment the version.

### Submodule conflicts

- Resolve in the submodule first, then update the monorepo reference

---

## Related Docs

- [packages/agentos/docs/RELEASING.md](../packages/agentos/docs/RELEASING.md) — Detailed agentos release guide
- [CONTRIBUTING.md](../.github/CONTRIBUTING.md) — Development guidelines
