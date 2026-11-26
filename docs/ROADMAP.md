# Implementation Roadmap

Build sequentially. Every phase has a gate; do not build the next phase on top of failing foundations.

## Phase 0 — Repository discovery and technical spike

**Goal:** Confirm the real package APIs and prove the runtime baseline.

Deliverables:
- Inspect repository and preserve any existing work.
- Verify supported Node LTS, pnpm, MCP SDK stable API, SQLite driver compatibility, Drizzle migration behavior.
- Verify latest platform config docs for all five agents.
- Create initial ADRs and `IMPLEMENTATION_STATUS.md`.

Gate:
- A minimal MCP stdio server can start and expose a `ping`/status tool in a test client.
- SQLite driver installs and runs in Linux CI; add Windows/macOS to CI or mark support limitations.

## Phase 1 — Domain core and SQLite

**Goal:** Implement the data model and deterministic use cases.

Deliverables:
- Workspace structure and shared contracts.
- Migrations for projects, tasks, focus sessions, worklogs, settings.
- Repository interfaces and SQLite implementations.
- Task/project CRUD use cases.
- Focus and worklog use cases.
- Deterministic planner and review calculations.
- Unit/integration tests.

Gate:
- Core tests pass without needing an MCP or CLI runtime.
- Database migrations work on a fresh profile and a prior-version fixture.

## Phase 2 — CLI

**Goal:** Make Daymark usable without any AI agent.

Commands:
- `daymark init`
- `daymark status`
- `daymark project add|list|archive`
- `daymark task add|list|show|update|done|cancel|archive`
- `daymark plan today --available-minutes <n>`
- `daymark focus start|stop|list`
- `daymark worklog add|list`
- `daymark review day|week`
- `daymark export|import --dry-run`

Gate:
- CLI end-to-end scenario works using a temporary data directory.
- `--json` output is stable and documented.

## Phase 3 — MCP server

**Goal:** Expose the same use cases through MCP stdio.

Deliverables:
- Tool schemas and descriptions from `MCP_CONTRACT.md`.
- Structured output and safe error mapping.
- Configurable DB/profile through process env only.
- Tests with an MCP client; no stdout noise.

Gate:
- Read and write from MCP, then read same records through CLI.
- Verify idempotency, validation failures, active focus conflict, pagination.

## Phase 4 — Portable Skills

**Goal:** Teach agents the intended workflows.

Deliverables:
- Daily planning, daily wrap, task triage Skills.
- Test fixtures and prompt-based manual eval checklist.
- Shared Skill content free from provider-specific syntax.

Gate:
- All Skills reference only tools that exist in the MCP contract.
- Skills never ask the agent to fabricate durations, deadlines, or worklog events.

## Phase 5 — Five-platform Tier 1 integrations

**Goal:** MCP + Skills usable from Claude Code, Codex, Cursor, Antigravity, OpenCode.

Deliverables:
- Setup docs for each platform.
- Generated MCP config format per platform.
- Installer/doctor commands where useful.
- Compatibility matrix with evidence.

Gate:
- Tier 1 test matrix passes or limitation is explicitly documented for each platform.

## Phase 6 — Native packaging

**Goal:** Make install/discovery easier with platform-specific packages.

Deliverables:
- Claude Code plugin package.
- Codex plugin package.
- Cursor Agent Plugin and/or Cursor-native package.
- Antigravity plugin package and validator run.
- OpenCode native plugin only if it adds meaningful value beyond MCP + Skills.

Gate:
- Each manifest validates against current platform rules.
- Installation and uninstall do not touch user data.

## Phase 7 — Release 0.1.0

Deliverables:
- README, quickstart, screenshots of CLI, examples, changelog.
- License selected after owner decision; use a permissive license only after confirming project intent.
- CI release workflow, package provenance/checksums if practical.
- Security and privacy statement.
- Known limitations and compatibility dates.

## Post-MVP backlog

1. Web dashboard/PWA.
2. Calendar read integration and time-block suggestions.
3. GitHub/Linear read integration.
4. Obsidian/Markdown knowledge capture.
5. Optional ActivityWatch import (explicit opt-in, local only).
6. Native hooks for explicit session lifecycle/worklog support.
7. Optional encrypted sync / multi-device architecture.
8. Notifications/reminders, recurring tasks, goals, habits.
