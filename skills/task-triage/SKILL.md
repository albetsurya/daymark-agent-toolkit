---
name: daymark-task-triage
description: Capture and organize a user's incoming tasks, clarify only essential missing information, and apply explicit project, priority, estimate, and due-date data in Daymark.
compatibility: Requires Daymark MCP tools daymark_capture_task, daymark_list_projects, daymark_list_tasks, and daymark_update_task.
metadata:
  author: daymark
  version: "0.1.0"
---

# Daymark Task Triage

## Workflow

1. Determine whether the user is asking to capture a task or only discussing an idea. Capture only when the intent is clear.
2. Extract the task title and useful description.
3. Match a project only when the project is unambiguous; otherwise leave it unassigned or ask one concise question if required.
4. Do not invent deadlines or estimates. Leave unknown values empty.
5. If priority is not stated, use `none` rather than assuming urgency.
6. Create the task with `daymark_capture_task` and report the returned ID and saved fields.
7. For existing tasks, inspect with `daymark_list_tasks` or `daymark_get_task` before updating. Never overwrite fields not requested by the user.

## Confirmation rules

- Creating a task is allowed when the user explicitly asked to add/capture/remember it.
- Changing a deadline, deleting, archiving, or completing a task requires clear user intent.
- Never create duplicate tasks when the user is referring to an existing task; search first.
