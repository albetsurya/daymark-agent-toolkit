# Architecture

## 1. High-level architecture

```text
Local AI Agents (STDIO) ──┐
Standalone Web Dashboard ─┼─► Interface & Transport Adapters
Claude Web (Remote MCP) ──┤     ├─ @daymark/cli (CLI)
Terminal CLI (daymark) ───┘     ├─ @daymark/mcp-server (STDIO & Streamable HTTP /mcp)
                                └─ @daymark/web (Node HTTP API 127.0.0.1 + React SPA)
                                         │
                             @daymark/core (Shared Core)
                               ├─ application/ (Use cases + ExecutionContext + PermissionPolicy)
                               ├─ domain/ (Pure planner, reviews, rules, IANA time)
                               └─ storage/ (DaymarkStore + AsyncDaymarkStore ports)
                                         │
                              @daymark/storage-sqlite
                                         │
                                Local Daymark Store
```

All interfaces (CLI, STDIO MCP, Local Web Dashboard, and Remote Streamable HTTP MCP) execute the exact same `@daymark/core` application services and domain logic through centralized `createGuardedDaymarkService` permission checks. No interface or browser client may access SQLite directly.

## 2. Monorepo packages

```text
apps/
  web/                # Standalone React + TypeScript dashboard + local Node HTTP server (127.0.0.1)
packages/
  contracts/          # Zod schemas, shared DTOs, errors, versioned contracts
  core/               # Separated domain/, storage/ (sync & async ports), application/ (use cases + policy)
  storage-sqlite/     # Drizzle schema, migrations, SQLite repository implementations
  cli/                # Commander CLI adapter
  mcp-server/         # MCP STDIO and Streamable HTTP (/mcp) server adapters
  skills/             # Portable SKILL.md workflows and references
  platform-adapters/  # Packaging/install/validation adapters per agent
  config/             # Runtime configuration and OS-conventional local paths
  test-fixtures/      # Shared deterministic fixtures
```

### Package Topology

| Package Name | Workspace Directory | Role |
|---|---|---|
| `@daymark/contracts` | `packages/contracts` | Zod schemas, shared DTOs, typed `DaymarkError` codes, backup archive schema |
| `@daymark/config` | `packages/config` | Runtime configuration and OS-conventional local paths (`0700`/`0600` permissions) |
| `@daymark/core` | `packages/core` | Separated domain, storage ports (`DaymarkStore` / `AsyncDaymarkStore`), application use cases, and permission policies |
| `@daymark/storage-sqlite` | `packages/storage-sqlite` | Drizzle schema, migrations, `better-sqlite3` driver verification, and WAL transactions |
| `@daymark/cli` | `packages/cli` | Commander CLI adapter (`daymark`) |
| `@daymark/mcp-server` | `packages/mcp-server` | MCP STDIO and Streamable HTTP (`/mcp`) server adapters |
| `@daymark/skills` | `packages/skills` | Portable SKILL.md workflows and validator |
| `@daymark/platform-adapters` | `packages/platform-adapters` | Packaging/install/validation adapters per AI platform |
| `@daymark/test-fixtures` | `packages/test-fixtures` | Shared deterministic fixtures (internal test fixture package) |
| `@daymark/web` | `apps/web` | Standalone React + TypeScript dashboard + local Node HTTP server (`127.0.0.1`) |

### Dependency direction

- `contracts` has no dependency on any other workspace package.
- `core` may depend on `contracts`, but not on SQLite, MCP, CLI, or platform packages.
- `storage-sqlite` implements interfaces defined by `core` or a small application port package.
- `cli` and `mcp-server` depend on `core` and `storage-sqlite` composition roots.
- `skills` are static assets; they document use cases and tool sequences.
- `platform-adapters` package skills and MCP config, and may add native wrappers. They must not import domain internals.

Avoid circular dependencies. If repository interfaces create awkward imports, place ports and DTOs in `contracts` or a separate `application` package.

## 3. Runtime modes

### Local CLI
`daymark <command>` loads config, opens the local SQLite DB, constructs repositories and use cases, runs the command, then closes the connection.

### Local MCP server
`daymark-mcp` starts an MCP server over `stdio`. It opens the same configured database. The server must not print logs to stdout because stdout is the MCP transport; diagnostics go to stderr.

### Local Web Dashboard (`apps/web`)
`daymark-web` binds strictly to `127.0.0.1` (default port `3456`) and serves a React + TypeScript SPA backed by a Node.js HTTP API (`/api/*`). Every API request validates `Host`/`Origin` headers and requires an HMAC-bound CSRF token (`GET /api/csrf` + `HttpOnly; SameSite=Strict` cookie + `X-CSRF-Token`) on mutations. Browser code never touches SQLite directly and `dataDir` is redacted (`null`).

### Remote MCP Server (Streamable HTTP `/mcp`)
`daymark-mcp --http` serves MCP over Streamable HTTP at `/mcp` via `@modelcontextprotocol/server` (`createMcpHandler`), supporting Bearer token authentication (`DAYMARK_MCP_TOKEN`, optional read-only `DAYMARK_MCP_READONLY_TOKEN`) and multi-user OAuth 2.1 verifier integration (`/.well-known/oauth-protected-resource/mcp`), rate limiting, body/MIME validation, `Host`/`Origin` validation, `dataDir` redaction, and centralized permission policy checks. See [`docs/CLAUDE_WEB_INTEGRATION.md`](./CLAUDE_WEB_INTEGRATION.md) and [`docs/CLOUD_ARCHITECTURE.md`](./CLOUD_ARCHITECTURE.md).

## 4. Local filesystem layout

Follow OS conventions:

- Linux: `$XDG_DATA_HOME/daymark` or `~/.local/share/daymark`.
- macOS: `~/Library/Application Support/Daymark`.
- Windows: `%LOCALAPPDATA%/Daymark`.
- Config: `$XDG_CONFIG_HOME/daymark/config.json` or OS equivalent.
- Database: `<data-dir>/daymark.sqlite`.
- Backups: `<data-dir>/backups/`.

Allow overrides through `DAYMARK_HOME` and `DAYMARK_DATABASE_PATH`. Validate and normalize paths. Do not accept arbitrary paths from MCP tool input; path overrides are process configuration only.

## 5. Application use cases

Core use cases:

- `InitializeProfile`
- `GetSystemStatus`
- `CreateProject`, `ListProjects`, `UpdateProject`
- `CaptureTask`, `ListTasks`, `GetTask`, `UpdateTask`, `TransitionTask`
- `GenerateDailyPlan`
- `StartFocusSession`, `FinishFocusSession`, `ListFocusSessions`
- `CreateWorklogEntry`, `ListWorklogEntries`
- `GenerateDailyReview`, `GenerateWeeklyReview`
- `ExportBackup`, `ValidateImport`, `ImportBackup`

Use cases depend on repository ports and injected clock/timezone provider. This makes them testable without a real clock or database.

## 6. Planning algorithm

Implement as a pure function. Inputs: eligible tasks, date, timezone, available minutes. Output: ordered recommendations, skipped tasks and reason codes.

MVP ordering rules are specified in `PRODUCT_SPEC.md`. Keep rules configurable in a future version, but do not add a weighted opaque score in MVP.

## 7. Error model

Use stable error codes such as:

- `PROFILE_NOT_INITIALIZED`
- `TASK_NOT_FOUND`
- `PROJECT_NOT_FOUND`
- `INVALID_STATUS_TRANSITION`
- `INVALID_TIME_RANGE`
- `FOCUS_SESSION_ALREADY_ACTIVE`
- `FOCUS_SESSION_NOT_ACTIVE`
- `VALIDATION_FAILED`
- `DATABASE_BUSY`
- `IMPORT_CONFLICT`
- `BACKUP_VERSION_UNSUPPORTED`

Map domain errors into concise CLI messages and MCP `isError` results with a machine-readable code in structured output.

## 8. Cross-agent identity

Track a source hint, not a hard dependency on vendor identity:

```ts
type AgentSource =
  | "claude-code"
  | "codex"
  | "cursor"
  | "antigravity"
  | "opencode"
  | "other"
  | "unknown";
```

Allow explicit overrides. Do not trust arbitrary client metadata as authorization. The same database/profile is selected by process environment/config, not by agent-provided paths.

## 9. Future extension points

- Integration adapters: calendar, GitHub, Linear, Todoist, Obsidian, ActivityWatch.
- Web/PWA frontend over a local service or a user-controlled sync layer.
- Optional encrypted sync service.
- Recurring tasks, goals, habits, reminders, dependencies.
- Native hooks for opt-in session start/stop/worklog capture.

Do not create empty abstractions for every future idea. Implement only seams needed for current MVP.
