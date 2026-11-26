import type { Priority, ProjectDto, TaskStatus, TaskSummaryDto } from '@daymark/contracts';
import { useState } from 'react';
import { daymarkApi } from '../api';

export function TasksTab(props: {
  tasks: TaskSummaryDto[];
  projects: ProjectDto[];
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [estimate, setEstimate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const estNum = estimate.trim() ? Number(estimate.trim()) : undefined;
      await daymarkApi.captureTask({
        title: title.trim(),
        projectId: projectId || undefined,
        priority: priority || undefined,
        estimateMinutes: estNum,
        dueAt: dueDate.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      setTitle('');
      setEstimate('');
      setDueDate('');
      setTagsRaw('');
      setPriority('');
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(taskId: string, status: TaskStatus) {
    setBusy(true);
    try {
      if (status === 'completed') {
        await daymarkApi.completeTask(taskId);
      } else {
        await daymarkApi.updateTask(taskId, { status });
      }
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  const filtered = props.tasks.filter((t) => {
    if (statusFilter === 'open') {
      if (t.status !== 'inbox' && t.status !== 'todo' && t.status !== 'in_progress') return false;
    } else if (statusFilter !== 'all' && t.status !== statusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!t.title.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div>
      <div className="page-header">
        <h1>Tasks</h1>
        <div className="row">
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <select
            className="select"
            style={{ width: 160 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="open">Open Tasks</option>
            <option value="all">All Statuses</option>
            <option value="todo">Todo</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h2>Capture Task</h2>
        <form onSubmit={handleCapture} className="form-grid">
          <div className="field">
            <label htmlFor="t-title">Title</label>
            <input
              id="t-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Explicit task title"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="t-proj">Project (optional)</label>
            <select
              id="t-proj"
              className="select"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={busy}
            >
              <option value="">Unassigned</option>
              {props.projects
                .filter((p) => p.status === 'active')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="t-prio">Priority (optional)</label>
            <select
              id="t-prio"
              className="select"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority | '')}
              disabled={busy}
            >
              <option value="">Unset (none)</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="t-est">Estimate mins (optional)</label>
            <input
              id="t-est"
              className="input"
              type="number"
              min={1}
              max={10080}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder="Leave blank if unknown"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="t-due">Due date (optional)</label>
            <input
              id="t-due"
              className="input"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="t-tags">Tags (comma-separated)</label>
            <input
              id="t-tags"
              className="input"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="backend, mcp"
              disabled={busy}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || title.trim().length === 0}
          >
            Capture
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Task List ({filtered.length})</h2>
        {filtered.length === 0 ? (
          <div className="muted">No tasks found for this filter.</div>
        ) : (
          <div className="list">
            {filtered.map((task) => (
              <div key={task.id} className="list-item">
                <div>
                  <div className="row">
                    <span className="item-title">{task.title}</span>
                    <span className="badge badge-accent">{task.status}</span>
                    {task.priority !== 'none' && (
                      <span
                        className={`badge ${task.priority === 'high' ? 'badge-danger' : 'badge-warn'}`}
                      >
                        {task.priority}
                      </span>
                    )}
                    <span className="badge">{task.sourceAgent}</span>
                  </div>
                  <div className="item-meta">
                    {task.projectName ? `Project: ${task.projectName} · ` : ''}
                    {task.estimateMinutes !== null
                      ? `Estimate: ${task.estimateMinutes}m · `
                      : 'Unestimated · '}
                    {task.dueDate ? `Due: ${task.dueDate}` : 'No due date'}
                    {task.tags.length > 0 ? ` · Tags: ${task.tags.join(', ')}` : ''}
                  </div>
                </div>
                <div className="row">
                  <select
                    className="select"
                    style={{ width: 135 }}
                    value={task.status}
                    disabled={busy}
                    onChange={(e) => void handleStatusChange(task.id, e.target.value as TaskStatus)}
                  >
                    <option value="inbox">inbox</option>
                    <option value="todo">todo</option>
                    <option value="in_progress">in_progress</option>
                    <option value="completed">completed</option>
                    <option value="cancelled">cancelled</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
