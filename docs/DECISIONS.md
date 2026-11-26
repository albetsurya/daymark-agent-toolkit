# Architecture Decisions and Open Questions

## Accepted baseline decisions

### ADR-001 — Local-first SQLite for MVP

**Decision:** Store a single user's profile in local SQLite.  
**Reason:** Avoid cloud, auth, sync, and privacy complexity while validating core workflows.  
**Consequence:** Cross-agent interoperability on the same machine/profile works immediately; cross-device sync is post-MVP.

### ADR-002 — MCP + portable Skills as the cross-agent baseline

**Decision:** Use MCP for typed actions/data and Agent Skills for repeatable workflows.  
**Reason:** This avoids coupling the core to an individual agent and uses existing extension surfaces.  
**Consequence:** Each platform still needs a configuration or package adapter; native hooks are optional.

### ADR-003 — Deterministic productivity engine

**Decision:** The core does not call LLM APIs. Prioritization, duration, and reviews are computed from explicit records and rules.  
**Reason:** Reproducibility, privacy, lower cost, provider independence.  
**Consequence:** Natural-language interpretation lives in the agent Skill/model, while tool calls are typed.

### ADR-004 — No dashboard in MVP

**Decision:** CLI and MCP first.  
**Reason:** Validate useful workflows before building a second UX surface.  
**Consequence:** Post-MVP dashboard will consume the same contracts/use cases.

## Open decisions for implementation agent

1. SQLite driver: compare `better-sqlite3` with `@libsql/client` local mode for supported Node LTS and OS packaging; document decision. -> **Resolved in ADR-006 (`better-sqlite3`).**
2. Timestamp storage: choose integer epoch milliseconds or ISO strings and use consistently. -> **Resolved in ADR-008 (integer epoch ms UTC in SQLite, ISO-8601 UTC strings at API boundaries).**
3. Task date-only due dates: decide whether model stores date-only separately from instant due_at; avoid implicit UTC-midnight conversion. -> **Resolved in ADR-008 (dedicated `due_date` YYYY-MM-DD column + local end-of-day policy in configured IANA timezone).**
4. CLI interaction: use non-interactive commands by default; add prompts only for missing required information. -> **Resolved in ADR-009 (non-interactive Commander commands + `--json` scriptable mode).**
5. License: do not choose without owner approval. Present MIT, Apache-2.0, and MPL-2.0 trade-offs before first public release. -> **Resolved in ADR-011 (`Apache-2.0` adopted `2026-11-26`).**
6. Product name: Daymark is provisional; perform availability and trademark checks before public release. -> **Open (updated from Daybook in ADR-012; internal scope `@daymark/*` kept configurable and packages private until clearance).**

## Change control

A change to product scope, public MCP tool name, persisted data model, platform packaging contract, or security behavior requires an entry here with context, decision, consequences, and migration impact.

## Implementation ADRs (2026-11-26)

### ADR-005 — Workspace package scope (`@daymark/*`) and private internal manifests

**Context:** Daymark is a working title pending trademark, domain, and registry clearance (`REPOSITORY_NAMING.md`, `DECISIONS.md` #6).  
**Decision:** Name workspace packages `@daymark/contracts`, `@daymark/config`, `@daymark/core`, `@daymark/storage-sqlite`, `@daymark/cli`, `@daymark/mcp-server`, `@daymark/skills`, `@daymark/platform-adapters`, and `@daymark/test-fixtures`, all marked `"private": true` until final naming clearance. Expose CLI bins `daymark` and `daymark-mcp`.  
**Consequences:** Internal imports stay consistent across packages and refactoring the npm scope later only changes `package.json` names and imports.

### ADR-006 — SQLite driver selection: `better-sqlite3` over `@libsql/client`

**Context:** `docs/TECH_STACK.md` requires comparing `better-sqlite3` and `@libsql/client` (local mode) on Node LTS (`v24.21.0`) and cross-platform packaging before selection.  
**Technical spike findings (2026-11-26):**
- `better-sqlite3@13.2.0` ships prebuilt `.node` binaries inside `prebuilds/` for 8 targets (`linux-x64`, `linux-arm64`, `linuxmusl-x64`, `linuxmusl-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`), executes SQLite `3.54.1` synchronously without requiring C++ compilation on supported Node LTS targets, supports native synchronous ACID transactions (`db.transaction(...)`) and partial unique indexes (`WHERE status = 'active'`), and raises standard `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_BUSY` error codes.
- `@libsql/client@0.18.0` runs an older SQLite/libSQL engine (`3.45.1`), pulls remote HTTP transport dependencies (`@libsql/hrana-client`, `js-base64`) unused in local-first MVP, and forces async client calls even for local file access.
**Decision:** Select `better-sqlite3@13.2.0` with `drizzle-orm@0.45.4` (`drizzle-orm/better-sqlite3` + `drizzle-orm/better-sqlite3/migrator`). Enable `WAL` mode, `foreign_keys = ON`, and `busy_timeout = 5000`.  
**Consequences:** No remote-client transport overhead and deterministic synchronous transaction enforcement for the single-active-focus-session invariant. Reversing this decision is confined to `packages/storage-sqlite`.

### ADR-007 — Official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/client`)

**Context:** The official MCP TypeScript SDK provides the modular v2 release line (`@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0`) supporting the `2026-07-28` MCP specification alongside legacy `2025-*` `initialize` compatibility (`serveStdio` default `legacy: 'serve'`), plus native Standard Schema / Zod v4 (`zod@4.6.7`) support.  
**Decision:** Use `@modelcontextprotocol/server` (`2.4.0`) for the production stdio server and `@modelcontextprotocol/client` (`2.4.0`) for integration tests, paired with `zod` (`4.6.7`).  
**Consequences:** Native `structuredContent` + `outputSchema` support without `zod-to-json-schema` shims, compatibility with both `2025-*` and `2026-07-28` MCP clients, and separation of transport from `core`.

### ADR-008 — UTC epoch millisecond storage and date-only due date policy

**Context:** `docs/DATA_MODEL.md` requires storing instants in UTC and interpreting dates/week boundaries in the configured IANA timezone without shifting date-only deadlines to UTC midnight.  
**Decision:**
- Store persisted instants (`created_at`, `updated_at`, `completed_at`, `archived_at`, `started_at`, `ended_at`, `occurred_at`, `expires_at`, `applied_at`, `due_at`) as SQLite `INTEGER` epoch milliseconds (UTC).
- Serialize all timestamps at API/DTO/backup boundaries as ISO-8601 UTC strings (`...Z`).
- Store date-only task deadlines (`YYYY-MM-DD`) in a dedicated `due_date` (`TEXT NULL`) column while keeping instant deadlines in `due_at` (`INTEGER NULL`). When a caller supplies `dueAt` as `"YYYY-MM-DD"`, store `due_date` and keep `due_at` null; when evaluating overdue status, date-range filters (`dueBefore`/`dueAfter`), or planner sort order, interpret `due_date` as local end-of-day (`23:59:59.999`) in the profile's configured IANA timezone using Node's `Intl.DateTimeFormat`. Reject ambiguous naive datetime strings without a date-only format or explicit UTC offset.
**Consequences:** Date-only deadlines stay on the intended calendar date when users change timezones, and DST transitions are deterministic and unit-tested.

### ADR-009 — Toolchain, build, CLI behavior, and provisional license posture

**Context:** Need a minimal, reproducible toolchain aligned with `docs/TECH_STACK.md`.  
**Decision:**
- Package manager & monorepo: `pnpm` workspaces (`onlyBuiltDependencies: ["better-sqlite3", "esbuild"]`) with committed `pnpm-lock.yaml`.
- Build & typecheck: `tsdown` (`0.23.7`) + `typescript` (`7.0.2`, strict mode) emitting Node ESM (`.mjs` + `.d.mts`) with explicit package `exports` maps.
- Lint & format: `@biomejs/biome` (`2.6.9`).
- Testing: `vitest` (`5.1.1`) split into `unit` and `integration` projects.
- Logging: `pino` (`10.4.0`) writing opt-in diagnostic logs strictly to `stderr` in MCP mode with field redaction for task titles, descriptions, notes, and worklog text.
- CLI: `commander` (`15.1.0`), non-interactive by default, supporting `--json` on every command and `--confirm` / `--force` gates on destructive operations.
- License: Initially marked `"UNLICENSED"` during Phase 0–6 until `MIT` vs `Apache-2.0` vs `MPL-2.0` review before 0.1.0 release. *(Superseded by ADR-011 on 2026-11-26.)*

### ADR-010 — Platform packaging schema refinements from real CLI validators (2026-11-26)

**Context:** Validating generated platform bundles against locally installed `agy` (`1.5.17`) and `opencode` (`v2.2.5`) surfaced two packaging requirements:
1. `agy plugin validate --strict` warns when a skill directory name (`daily-planning`) differs from `SKILL.md` frontmatter `name` (`daymark-daily-planning`).
2. `opencode mcp add` (`v2.2.5`) writes `mcp.servers.<name>` rather than top-level `mcp.<name>` inside `opencode.json`.
**Decision:** Keep canonical build-pack paths in `skills/` unchanged; have `@daymark/platform-adapters` write packaged skills under `<skill.id>/SKILL.md` (`daymark-daily-planning`, `daymark-daily-wrap`, `daymark-task-triage`), and emit `mcp.servers.daymark` in `dist/platforms/opencode/opencode.json`. Also omit `DAYMARK_HOME` from portable configs unless explicitly provided so platforms that do not interpolate `${DAYMARK_HOME}` fall back cleanly to OS-standard directories.  
**Consequences:** Zero `agy plugin validate --strict` errors or warnings in local mode, accurate `opencode debug config` parsing, and no hardcoded machine paths in portable bundles.

### ADR-011 — Apache-2.0 License Selection (2026-11-26)

**Context:** Adopting an open-source license before `0.1.0` required weighing `MIT`, `Apache-2.0`, and `MPL-2.0` trade-offs (see `LICENSE_DECISION.md`).  
**Decision:** Adopt Apache License, Version 2.0 (`Apache-2.0`) across the root `LICENSE` file, root `package.json`, all workspace `packages/*/package.json` manifests, and generated platform plugin metadata.  
**Consequences:** Enables permissive downstream adoption with explicit patent grant and patent retaliation clauses. Workspace packages remain `"private": true` until final product name and npm scope clearance (`DECISIONS.md` Open Decision #6).

### ADR-012 — Product rename from Daybook to Daymark (2026-11-26)

**Context:** Pre-release naming review replaced the working title `Daybook` with `Daymark` (repository slug `daymark-agent-toolkit`) via `daymark-agent-toolkit-build-pack` (`REPOSITORY_NAMING.md`) to avoid product/trademark collision.  
**Decision:** Adopt canonical Daymark identifiers across the entire pre-release codebase: CLI `daymark`, MCP binary `daymark-mcp`, MCP tool prefix `daymark_*`, npm workspace scope `@daymark/*`, env vars `DAYMARK_HOME` / `DAYMARK_DATABASE_PATH` / `DAYMARK_LOG_LEVEL`, data directories (`daymark` on Linux XDG, `Daymark` on macOS/Windows), and SQLite filename `daymark.sqlite`. Because no public release or user profile data exists yet, apply clean Daymark identifiers directly without adding legacy `daybook` migration paths (`REPOSITORY_NAMING.md`).  
**Consequences:** All 16 MCP tool names, workspace package names, config paths, skills, and platform adapters use consistent `Daymark` naming without altering domain logic or SQLite table schemas.
