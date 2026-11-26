---
name: daymark-daily-wrap
description: Close out a workday by reviewing recorded tasks, focus sessions, and worklogs, then identify incomplete work and prepare a factual daily summary.
compatibility: Requires Daymark MCP tools daymark_generate_daily_review and optionally daymark_log_work, daymark_complete_task.
metadata:
  author: daymark
  version: "0.1.0"
---

# Daymark Daily Wrap

## Workflow

1. Ask which date to review only when it cannot safely default to the current date in the configured timezone.
2. Call `daymark_generate_daily_review`.
3. Summarize completed work, active tasks, overdue tasks, focus time, and recorded worklogs.
4. Explicitly identify data gaps (for example, no worklog was recorded); do not infer work from conversation history or code changes unless the user confirms it.
5. Ask whether the user wants to record any missing work or mark a task complete. Do not make those changes without the user's instruction.
6. Suggest at most three next actions for tomorrow, grounded in current task data.

## Output format

- Completed
- Still in progress
- Overdue / blocked (if any)
- Focus and logged time
- Missing records
- Suggested next actions
