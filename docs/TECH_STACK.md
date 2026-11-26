# Technology Stack

## Selected stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict mode | Shared language across CLI, MCP, adapters and future web UI |
| Runtime | Current Node.js LTS at implementation kickoff | Cross-platform runtime; pin engines in package metadata |
| Package manager | pnpm | Workspace support and reproducible lockfile |
| Monorepo | pnpm workspaces | Simple package boundaries without premature orchestration complexity |
| MCP | Official MCP TypeScript SDK, stable release line | Native protocol implementation; verify SDK major version and migration notes before coding |
| Validation | Zod | Runtime validation and inferred TS types |
| Database | SQLite | Local-first, portable single-user persistence |
| ORM/migrations | Drizzle ORM + Drizzle Kit | Typed SQL and explicit migrations |
| CLI | Commander | Stable command and option parsing |
| Logging | Pino | Structured logs; write diagnostics to stderr in MCP mode |
| Tests | Vitest | Unit and integration test runner |
| Lint/format | Biome | One formatter/linter with low configuration overhead |
| Build | tsup or tsdown (choose one after checking current maintenance) | Package build for Node ESM; avoid multiple build systems |
| CI | GitHub Actions | Typecheck, lint, tests, build, package smoke tests |
| Release | Changesets | Versioning for multiple workspace packages |

## Runtime and module decisions

- Use ESM (`"type": "module"`) unless a target integration demonstrably requires CommonJS.
- Target the active Node.js LTS at implementation kickoff. Use a supported `engines.node` range and document Windows/macOS/Linux coverage.
- Pin all direct dependencies and commit `pnpm-lock.yaml`.
- Use `exports` maps for workspace packages; do not rely on TypeScript path aliases at runtime.
- Build distributable JS before publishing. Do not require consumers to execute TypeScript source.

## Database choice

Use SQLite with Drizzle. For the first implementation, select a well-maintained synchronous or asynchronous SQLite driver compatible with the supported Node LTS and CI OS matrix. The agent must compare `better-sqlite3` and `@libsql/client` (local SQLite mode) before selection, document the trade-off, and verify packaged/native install behavior. Do not introduce a remote libSQL service in MVP.

## Why not a backend in MVP?

A single-user local tool does not need a hosted API. A backend would create deployment, authentication, synchronization, privacy, and operational work before the product's core value is validated.

## Why no LLM SDK?

Daymark should work with any agent/model. Agent-native models already perform natural-language interpretation. The Daymark core provides deterministic tools and records. Avoid model vendor coupling and additional API costs.

## Future web stack (not MVP)

When core product/UX is validated:

- React + TypeScript.
- Vite for a client-only dashboard initially.
- TanStack Query for async server state if a local service/API exists.
- Tailwind CSS for styling.
- Reuse `contracts` types and a documented API client.

Do not add Next.js/TanStack Start or a second backend framework until SSR, hosted auth, or server rendering is a proven requirement.
