# Release Strategy & Package Distribution

Daymark Agent Toolkit is structured as a multi-package pnpm workspace where root `daymark-agent-toolkit` (`private: true`) coordinates 9 publishable packages under `@daymark/*` plus internal `@daymark/test-fixtures` (`private: true`).

---

## 1. Workspace Package Topology

| Package | Private | Role | Binary Entrypoint |
|---|---|---|---|
| `@daymark/contracts` | `false` | Shared Zod v4 DTOs and error contracts | — |
| `@daymark/config` | `false` | OS config/data paths and POSIX permissions | — |
| `@daymark/core` | `false` | Shared domain rules, planner, reviews, policy, storage ports | — |
| `@daymark/storage-sqlite` | `false` | SQLite/Drizzle repositories + migrations (`dist/migrations`) | — |
| `@daymark/skills` | `false` | Portable skills validator + bundled `dist/skills` | — |
| `@daymark/cli` | `false` | Terminal CLI (`daymark`) | `daymark` -> `./dist/bin.mjs` |
| `@daymark/mcp-server` | `false` | STDIO & Remote Streamable HTTP `/mcp` server | `daymark-mcp` -> `./dist/bin.mjs` |
| `@daymark/platform-adapters` | `false` | Platform manifest generators & bundle validator | `platform-adapters` |
| `@daymark/web` (`apps/web`) | `false` | Standalone React Web Dashboard + `127.0.0.1` HTTP API | `daymark-web` -> `./dist/server/bin.mjs` |
| `@daymark/test-fixtures` | `true` | Internal deterministic test fixtures (never published) | — |

All 9 publishable packages set `"files": ["dist"]`, `"publishConfig": { "access": "public" }`, `"license": "Apache-2.0"`, and `"engines": { "node": ">=22.12.0" }`.

---

## 2. Installing Locally Today (Without Waiting for Public npm)

### Option A — Local Installer Script (`scripts/install-local.sh`)

Installs `daymark`, `daymark-mcp`, and `daymark-web` wrappers into `~/.local/bin` (or `$DAYMARK_INSTALL_PREFIX/bin`):

```bash
./scripts/install-local.sh
daymark --version
daymark init --timezone Asia/Jakarta
daymark doctor
```

### Option B — Local npm Tarball Verification (`pnpm pack:npm`)

Generates `.tgz` packages inside `dist/npm/` using `pnpm pack` (automatically rewriting `workspace:*` specifiers into concrete semver ranges):

```bash
pnpm build
pnpm verify:release       # Packs and inspects all 9 tarballs in a temp dir
pnpm pack:npm             # Saves inspectable tarballs to dist/npm/
```

---

## 3. Publishing to npm Registry

Before publishing `@daymark/*` publicly:

1. Reserve the `@daymark` npm organization/scope (and optionally reserve unscoped `daymark` wrapper package if desired, following trademark checks).
2. Version packages cleanly with Changesets:
   ```bash
   pnpm changeset
   pnpm changeset version
   ```
3. Verify all gates and packed tarballs before publishing:
   ```bash
   pnpm lint
   pnpm format:check
   pnpm typecheck
   pnpm test
   pnpm test:integration
   pnpm verify:release
   ```
4. Publish via pnpm in topological order (`NPM_CONFIG_PROVENANCE=true` recommended in CI):
   ```bash
   pnpm -r --filter '!daymark-agent-toolkit' --filter '!@daymark/test-fixtures' publish --access public
   ```

Once published to npm, end users will be able to invoke commands directly via `npx` or global install:

```bash
# Scoped npm packages
npx --package=@daymark/cli daymark init
npx --package=@daymark/mcp-server daymark-mcp
npx --package=@daymark/web daymark-web --port 3456

# Optional future global install
npm install -g @daymark/cli @daymark/mcp-server @daymark/web
```

> **Note on unscoped `npx daymark`:** When the unscoped `daymark` name is reserved on npm, publishing a thin wrapper package named `daymark` re-exporting `@daymark/cli`'s `bin` enables direct `npx daymark <cmd>` without `--package`. Until public npm release, use `./scripts/install-local.sh` or `node packages/cli/dist/bin.mjs`.
