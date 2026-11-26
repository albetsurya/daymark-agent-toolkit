# Daymark Portable Skills — Prompt Evaluation Checklist

Use this checklist when evaluating `daymark-daily-planning`, `daymark-daily-wrap`, and `daymark-task-triage` across Claude Code, Codex, Cursor, Google Antigravity, and OpenCode.

## Pre-evaluation setup

1. Initialize an isolated test profile (`DAYMARK_HOME=/tmp/daymark-eval`).
2. Seed deterministic sample data using `SAMPLE_PLANNING_TASKS` from `@daymark/test-fixtures` or CLI commands:
   - 1 overdue medium-priority task (30m)
   - 1 high-priority task due today (60m)
   - 1 high-priority unestimated task (`estimateMinutes = null`)
   - 1 low-priority 180m task

## Manual Prompt Evals

### 1. `daymark-daily-planning`

- **Prompt A (missing budget):** `"What should I work on today?"`
  - **Pass:** Agent calls `daymark_get_status`, sees `defaultPlanMinutes` is unset, asks **one** concise question for available minutes, and does **not** guess free time or call `daymark_get_today_plan` with a fabricated budget.
- **Prompt B (explicit budget):** `"Plan my day with 90 minutes available."`
  - **Pass:** Agent calls `daymark_get_today_plan`, separates unestimated tasks from the 90m budget, highlights overdue tasks, states the plan is a recommendation (not a calendar booking), and does **not** mutate due dates or task status.

### 2. `daymark-daily-wrap`

- **Prompt A (end of day with missing worklog):** `"Let's wrap up my workday."`
  - **Pass:** Agent calls `daymark_generate_daily_review`, reports completed/in-progress/overdue tasks, focus time, logged work, and **explicitly names data gaps** without claiming unrecorded work happened.
- **Prompt B (user confirms completion):** `"Yes, mark the CLI task done and log 30 minutes for it."`
  - **Pass:** Agent invokes `daymark_complete_task` / `daymark_log_work` only after explicit instruction.

### 3. `daymark-task-triage`

- **Prompt A (brainstorming vs capture):** `"I'm thinking maybe we could support mobile someday."`
  - **Pass:** Agent treats it as discussion, does **not** call `daymark_capture_task` without clear user intent.
- **Prompt B (explicit capture without estimate/due date):** `"Add a task to audit SQLite indexes."`
  - **Pass:** Agent calls `daymark_capture_task` with `priority: "none"` (or omitted), leaves `estimateMinutes` and `dueAt` unset (never invents them), and reports the returned task ID.
- **Prompt C (update existing task):** `"Search for the SQLite index task and set priority to high."`
  - **Pass:** Agent searches via `daymark_list_tasks` first instead of creating a duplicate, then updates only `priority: "high"` via `daymark_update_task`.
