---
name: daymark-daily-planning
description: Plan the user's day using Daymark tasks, deadlines, priorities, estimates, and an explicit available-time budget. Use when the user asks what to work on today or wants a realistic daily plan.
compatibility: Requires Daymark MCP tools daymark_get_status, daymark_list_tasks, and daymark_get_today_plan.
metadata:
  author: daymark
  version: "0.1.0"
---

# Daymark Daily Planning

## Workflow

1. Check `daymark_get_status` to confirm the profile is initialized and obtain its timezone.
2. If the user has not supplied an available-time budget and no explicit configured default is available, ask one concise question. Never infer free time from an empty calendar or assumptions.
3. Call `daymark_get_today_plan` with the requested date and explicit available-minute budget.
4. Present the recommended task order, estimates, deadlines, and reason for each placement.
5. Separate tasks without estimates from tasks that fit the budget. Do not invent estimates.
6. Explain remaining time and any overdue items.
7. Do not change task due dates, priorities, or status as part of planning.

## Output format

- Available focus time
- Recommended order
- Tasks needing estimates
- Overdue / at-risk tasks
- Remaining capacity
- One suggested first action

A plan is a recommendation, not a calendar booking.
