# MCP Contract

## 1. Transport

Daymark exposes the exact same 16 tools and `@daymark/core` application services over two transports:

1. **Local `stdio` (`daymark-mcp`)**: Launched as a child process by local AI agent platforms. Logs go strictly to `stderr`; stdout carries MCP protocol frames only.
2. **Remote Streamable HTTP (`daymark-mcp --http`, endpoint `/mcp`)**: Uses `@modelcontextprotocol/server`'s `createMcpHandler` (Streamable HTTP for modern `2026-07-28` and `2025-*` MCP clients; legacy `/sse` is not used as primary transport). Enforces Bearer/OAuth authentication, `Host`/`Origin` allowlists, body-size and `application/json` checks, sliding-window rate limiting, structured redacted logging, path redaction (`dataDir: null`), and centralized `ExecutionContext` permission policies (`read` vs `write`, with `backup` disabled remotely).

## 2. Tool naming

Use stable names prefixed with `daymark_`. Tool descriptions must be concise and explain when to use the tool. Every input has a JSON Schema and is validated again inside the application boundary with Zod.

## 3. MVP tools

### Read tools

1. `daymark_get_status`
   - Input: `{}`
   - Output: initialized, app version, schema version, timezone, active focus session summary, data directory (do not expose secrets).

2. `daymark_list_projects`
   - Input: `{ status?: "active" | "archived" | "all", limit?: number, cursor?: string }`
   - Output: projects, `nextCursor`.

3. `daymark_list_tasks`
   - Input: `{ status?: TaskStatus | TaskStatus[], priority?: Priority, projectId?: string, dueBefore?: string, dueAfter?: string, query?: string, limit?: number, cursor?: string }`
   - Output: task summaries, `nextCursor`.

4. `daymark_get_task`
   - Input: `{ taskId: string }`
   - Output: full task and related project name.

5. `daymark_get_today_plan`
   - Input: `{ date?: "YYYY-MM-DD", availableMinutes?: number }`
   - Output: planned tasks, unestimated tasks, excluded tasks, total estimated minutes, remaining minutes, rule explanations, timezone.

6. `daymark_list_worklog`
   - Input: `{ from: string, to: string, projectId?: string, taskId?: string, sourceAgent?: AgentSource, limit?: number, cursor?: string }`
   - Output: entries and aggregate totals.

### Write tools

7. `daymark_create_project`
   - Input: `{ name: string, description?: string }`
   - Output: created project.

8. `daymark_update_project`
   - Input: `{ projectId: string, name?: string, description?: string | null, status?: "active" | "archived" }`
   - Output: updated project.

9. `daymark_capture_task`
   - Input: `{ title: string, description?: string, projectId?: string, priority?: Priority, estimateMinutes?: number, dueAt?: string, sourceAgent?: AgentSource, idempotencyKey?: string }`
   - Output: created task and fields that were left unspecified.

10. `daymark_update_task`
   - Input: `{ taskId: string, title?: string, description?: string | null, projectId?: string | null, priority?: Priority, estimateMinutes?: number | null, dueAt?: string | null, status?: TaskStatus }`
   - Output: updated task. Null explicitly clears nullable values.

11. `daymark_start_focus`
   - Input: `{ taskId?: string, projectId?: string, note?: string, sourceAgent?: AgentSource }`
   - Output: active focus session. Return a clear conflict if another active session exists; never silently replace it.

12. `daymark_finish_focus`
    - Input: `{ sessionId?: string, note?: string, createWorklog?: boolean }`
    - Output: finished session and elapsed duration. Creating a worklog is optional and must be deterministic; if enabled, use a documented summary.

13. `daymark_log_work`
    - Input: `{ summary: string, details?: string, taskId?: string, projectId?: string, focusSessionId?: string, durationMinutes?: number, occurredAt?: string, sourceAgent?: AgentSource, idempotencyKey?: string }`
    - Output: created worklog entry.

14. `daymark_complete_task`
    - Input: `{ taskId: string, completionNote?: string }`
    - Output: completed task. If completion note is supplied, create a linked worklog entry in one transaction.

15. `daymark_generate_daily_review`
    - Input: `{ date?: string }`
    - Output: structured sections: completed tasks, in-progress tasks, overdue tasks, focus time, worklog entries, data gaps, suggested next actions.

16. `daymark_generate_weekly_review`
    - Input: `{ weekOf?: string }`
    - Output: same categories aggregated across the configured week, including day-by-day totals.

## 4. Structured output shape

Where supported, return both human-readable text and machine-readable `structuredContent`. Use stable DTOs defined in `packages/contracts`. Avoid sending entire descriptions when the user requested a summary. Limit list results and use cursor pagination.

## 5. Write semantics

- Write tools perform only the operation requested by their arguments.
- Do not let a generic tool accept arbitrary SQL, filesystem paths, shell commands, or code snippets.
- A repeated `idempotencyKey` must not create duplicate tasks/worklogs; document the key retention policy.
- Do not silently change task deadlines, estimates, or priorities.
- Task completion and any requested linked worklog must occur in one transaction.
- A focus session start must fail clearly if another session is active.

## 6. Error semantics

Return machine-readable error code, concise message, and safe next step. Do not include stack traces, DB paths, or private data. Mark MCP tool failures with the protocol's error mechanism.

## 7. Tool descriptions for agents

Descriptions should steer correct tool selection:

- Capture a task when the user explicitly asks to remember, track, or add a task.
- Generate a daily plan only after obtaining or asking for available time if not configured; do not invent free time.
- Start focus only when the user explicitly asks to begin focus/work tracking.
- Log work based on user-provided or clearly available completed-work evidence; do not infer completed work solely from code diffs.
- Generate reviews from stored Daymark records only; label gaps.
