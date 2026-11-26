# Product Requirements Document

## 1. Product summary

**Product:** Daymark (working name)  
**Category:** Universal productivity toolkit for people and AI agents  
**Delivery model:** Open-source, local-first, extensible  
**Primary surfaces:** CLI, MCP server, portable Agent Skills, native agent packages  
**MVP user:** Individual developer or knowledge worker using one or more AI agents.

### Vision

Give a person and their AI agents one reliable, inspectable record of tasks, plans, focus sessions, and work completed—independent of which agent or editor is currently being used.

### Core promise

**Your work, organized. Your AI, connected.**

## 2. Problem statement

Work context becomes fragmented across IDEs, terminal sessions, task managers, notes, and AI conversations. A user may start a task with Claude Code, continue in Cursor, and ask Codex to review it, while the task state and worklog remain scattered. Agent transcripts are not a dependable task database.

Daymark centralizes the user's intentional productivity records and exposes them through standard interfaces.

## 3. Product principles

1. **One source of truth:** agents are interchangeable clients; Daymark owns the structured records.
2. **Local-first:** essential functionality works offline without an account.
3. **Agent-agnostic:** no vendor-specific model API is required by the core.
4. **Human-directed:** the user controls priorities, time budgets, and side effects.
5. **Deterministic core:** estimates, sorting, scheduling, and summaries over known records must be reproducible.
6. **Portable workflow guidance:** Agent Skills describe workflows; MCP and CLI provide controlled actions.
7. **Privacy by default:** no passive monitoring or telemetry in MVP.

## 4. Personas

### P1 — Multi-agent developer
Uses Claude Code, Codex, Cursor, Antigravity, or OpenCode. Needs tasks and work context to survive switching tools.

### P2 — Independent professional
Manages client work, deadlines, focus time, and daily deliverables. Wants a simple daily workflow without adopting a large project-management suite.

### P3 — Knowledge worker
Needs task capture, daily planning, and work reviews, and may use an AI agent for writing, research, or automation.

## 5. Jobs to be done

- When an idea or task appears, capture it quickly without losing context.
- Before starting work, decide what fits in the time available.
- During work, record the focus session and context.
- When switching agents, retrieve the same task and project state.
- At the end of a day or week, see what was completed, what remains, and what needs attention.

## 6. MVP scope

### Included

- Local profile and SQLite database initialization.
- Projects: create, list, inspect, update, archive.
- Tasks: capture, list, search/filter, inspect, update, complete, cancel, archive.
- Task attributes: title, description, project, status, priority, estimate, due date, tags, created/updated timestamps.
- Daily planning using a user-supplied available-minute budget.
- Focus sessions: start, finish, list; associate a session with a task/project and agent name when known.
- Worklog: explicit entries with timestamp, summary, duration, task/project, source agent.
- Daily review and weekly review based only on recorded data.
- CLI and MCP access to the same application use cases.
- Three portable Skills: daily planning, daily wrap, task triage.
- Platform setup instructions and generated MCP/Skills configuration for five agents.
- JSON export and restore with validation.

### Excluded from MVP

- Web dashboard and mobile app.
- Hosted accounts, multi-device sync, team collaboration, billing.
- Email, calendar, Slack, Todoist, Linear, GitHub write integrations.
- Automatic browser/editor/window tracking or screenshot capture.
- AI model orchestration/provider API keys inside Daymark.
- Automatic deadline changes or autonomous task deletion.
- Complex project dependencies, Gantt charts, recurring tasks, habit tracking.

## 7. Functional requirements

### FR-01 Initialization
The user can run `daymark init`. It creates a local data directory, database, config, and initial schema. Re-running init is safe and must not overwrite existing user data.

### FR-02 Task capture
The user or agent can create a task with a title. Optional fields may include description, project, priority, estimate, due date, and tags. Missing fields remain null or use explicit documented defaults; never infer an exact due date or duration.

### FR-03 Task lifecycle
The user can list and update tasks. Allowed statuses: `inbox`, `todo`, `in_progress`, `completed`, `cancelled`, `archived`. Status transitions are validated. Completion records `completed_at`.

### FR-04 Projects
A project can group tasks and worklogs. Projects have `name`, optional `description`, `status`, and timestamps.

### FR-05 Daily plan
The user provides a date and available-minute budget. Daymark returns a ranked suggested list from eligible tasks. It reports selected tasks, excluded tasks, reasons, total estimate, and remaining budget. It does not edit task due dates or calendar events.

### FR-06 Focus sessions
A user starts a focus session for a task (or an unspecific focus block), optionally records the source agent, and explicitly finishes it. The elapsed duration is calculated from stored timestamps. Interrupted/unfinished sessions are visible and recoverable.

### FR-07 Worklog
A worklog entry records what was done, optionally linked to task/project/focus session and agent. Users can query by date range, project, task, and agent.

### FR-08 Reviews
Daily and weekly reviews summarize only known records. They must label missing information rather than inventing output. Review sections: completed, in progress, overdue, focus time, logged work, suggested next actions.

### FR-09 Cross-agent context
All clients read/write the same local database. Worklogs may identify `source_agent` from the MCP client metadata or explicit input, but unknown source is allowed.

### FR-10 CLI and MCP parity
Core use cases must be reachable from both CLI and MCP. The CLI may have richer interactive presentation; business logic must be shared.

### FR-11 Export/import
Export produces a versioned JSON archive. Import validates schema and IDs, supports dry-run, and refuses destructive overwrite unless explicitly confirmed.

### FR-12 CLI Command Reference

The `daymark` CLI provides operational access to the shared core:

| Command | Arguments / Flags | Description |
|---|---|---|
| `daymark init` | `[--timezone <tz>] [--start-hour <h>]` | Initializes local data directory, SQLite DB, and configuration |
| `daymark status` | `[--json]` | Checks initialization status, active focus, and DB stats |
| `daymark doctor` | `[--json]` | Validates environment, C++ driver readiness, SQLite integrity, and MCP bundle |
| `daymark project add` | `<name> [--description <desc>]` | Creates a new project |
| `daymark project list` | `[--status <status>]` | Lists projects (`active`, `archived`, `all`) |
| `daymark project update` | `<projectId> [--name <name>] [--description <desc>]` | Updates project name or description |
| `daymark project archive` | `<projectId>` | Archives an active project |
| `daymark task add` | `<title> [--project <id>] [--priority <p>] [--estimate <m>] [--due <d>]` | Captures a task with explicit null preservation |
| `daymark task list` | `[--status <s>] [--priority <p>] [--project <id>] [--search <q>]` | Lists tasks with filtering and pagination |
| `daymark task show` | `<taskId>` | Displays full details and project association for a task |
| `daymark task update` | `<taskId> [--title <t>] [--priority <p>] [--estimate <m>] [--due <d>]` | Updates explicit task fields |
| `daymark task done` | `<taskId> [--note <n>]` | Marks a task completed, optionally recording worklog in same transaction |
| `daymark task cancel` | `<taskId> [--reason <r>]` | Cancels an active task |
| `daymark task archive` | `<taskId>` | Archives a task |
| `daymark plan today` | `[--available-minutes <m>] [--timezone <tz>]` | Computes deterministic daily plan for minute budget |
| `daymark focus start` | `[--task <id>] [--note <n>]` | Starts an active focus session (enforces max 1 active) |
| `daymark focus stop` | `[--worklog] [--note <n>]` | Stops active focus session and optionally creates worklog |
| `daymark focus list` | `[--limit <n>]` | Lists recent and active focus sessions |
| `daymark worklog add` | `<summary> [--duration <m>] [--task <id>]` | Records an explicit worklog entry |
| `daymark worklog list` | `[--from <d>] [--to <d>] [--project <id>]` | Lists worklogs in a date/time range |
| `daymark review day` | `[--date <d>] [--timezone <tz>]` | Generates structured daily summary and data gaps |
| `daymark review week` | `[--date <d>] [--timezone <tz>]` | Generates structured weekly review with DST-aware daily totals |
| `daymark export` | `<file>` | Exports complete profile to a verified JSON backup |
| `daymark import` | `<file> [--mode merge\|replace] [--confirm]` | Restores data from JSON backup archive |

## 8. Prioritization and planning behavior

The MVP planner must be deterministic and explainable. Initial ordering:

1. Exclude completed, cancelled, archived, and blocked tasks (blocked/dependency state is postponed; no dependencies in MVP).
2. Put overdue tasks ahead of non-overdue tasks.
3. Sort by priority (`high`, `medium`, `low`, `none`).
4. Within priority, sort by due date ascending; tasks without due dates sort later.
5. Use creation time as a stable tie-breaker.
6. Fill the available-minute budget greedily in that order. A task without an estimate appears in an `unscheduled_missing_estimate` section and does not consume guessed time.

The plan must say it is a recommendation, not an automatically reserved calendar schedule. No hidden score should be shown as AI certainty.

## 9. Non-functional requirements

- Local CLI cold start target: under 500 ms on a typical modern developer machine after installation (measure; do not promise before profiling).
- MCP tools must return quickly for local operations; avoid long-running model calls.
- Database transactions protect multi-record updates.
- Data migrations must be forward-only and versioned; provide backup instructions before migration.
- CLI supports Linux, macOS, and Windows where Node.js is supported.
- Structured logs are opt-in for diagnostics and redact user content.
- All user-facing dates use configured IANA timezone; store instants in UTC.

## 10. MVP acceptance criteria

- Fresh install can initialize a database and run a health/status command.
- A task created through CLI is visible through MCP and vice versa.
- A task created in one agent workflow is readable from another agent using the same profile/database.
- Daily planning is deterministic for the same database state, date, timezone, and budget.
- Worklog and focus duration calculations are tested for timezone and daylight-saving boundaries.
- Daily/weekly reports never fabricate tasks, dates, durations, or completed work.
- Export then import into a new profile preserves supported records and relationships.
- All MCP tools validate inputs and return stable structured output.
- Platform adapters are reported with evidence-based verification status, not assumed compatible.
