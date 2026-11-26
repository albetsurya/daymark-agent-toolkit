# Architecture

## 1. High-level architecture

```text
Claude Code ─┐
Codex ───────┤       portable Skills + per-platform package
Cursor ──────┤                    │
Antigravity ─┤                    ▼
OpenCode ────┘              MCP Server / CLI
                                  │
                          Application Use Cases
                                  │
                             Domain Core
                                  │
                       Repository Interfaces
                                  │
                          SQLite Adapter
                                  │
                        Local Daymark Store
```

The CLI and MCP server are adapters over the same application use cases. No platform-specific code may access SQLite directly.

## 2. Monorepo packages

```text
apps/
  # No web app in MVP. Reserve this directory for post-MVP surfaces.
packages/
  contracts/          # Zod schemas, shared DTOs, errors, versioned contracts
  core/               # Domain entities, use cases, planner, review calculations
  storage-sqlite/     # Drizzle schema, migrations, repository implementations
  cli/                # Commander CLI adapter
  mcp-server/         # MCP stdio server adapter
  skills/             # Portable SKILL.md workflows and references
  platform-adapters/  # Packaging/install/validation adapters per agent
  config/             # Runtime configuration and platform-independent paths
  test-fixtures/      # Shared deterministic fixtures
```

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

### Future remote MCP server
Not in MVP. If added, use Streamable HTTP with authentication, per-user isolation, rate limiting, audit logs, and explicit deployment documentation. Never expose a local user's SQLite file directly over an unauthenticated network listener.

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
