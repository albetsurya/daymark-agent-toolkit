import type {
  ActiveFocusSummary,
  FocusSessionDto,
  ProjectDto,
  TaskSummaryDto,
} from '@daymark/contracts';
import { useEffect, useState } from 'react';
import { daymarkApi } from '../api';

function formatElapsed(startedAtIso: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - Date.parse(startedAtIso)) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function FocusTab(props: {
  activeFocus: ActiveFocusSummary | null;
  sessions: FocusSessionDto[];
  tasks: TaskSummaryDto[];
  projects: ProjectDto[];
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [taskId, setTaskId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [startNote, setStartNote] = useState('');
  const [finishNote, setFinishNote] = useState('');
  const [createWorklog, setCreateWorklog] = useState(true);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    if (!props.activeFocus) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [props.activeFocus]);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await daymarkApi.startFocus({
        taskId: taskId || undefined,
        projectId: projectId || undefined,
        note: startNote.trim() || undefined,
      });
      setStartNote('');
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish(status: 'completed' | 'interrupted') {
    setBusy(true);
    try {
      await daymarkApi.finishFocus({
        status,
        note: finishNote.trim() || undefined,
        createWorklog,
      });
      setFinishNote('');
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  const openTasks = props.tasks.filter(
    (t) => t.status === 'inbox' || t.status === 'todo' || t.status === 'in_progress',
  );

  return (
    <div>
      <div className="page-header">
        <h1>Focus Session</h1>
      </div>

      {props.activeFocus ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <span className="badge badge-success">ACTIVE SESSION</span>{' '}
              <span className="badge">{props.activeFocus.sourceAgent}</span>
            </div>
            <div className="stat-value" style={{ fontSize: '2rem', margin: 0 }}>
              {formatElapsed(props.activeFocus.startedAt, nowMs)}
            </div>
          </div>
          {props.activeFocus.note && (
            <div className="item-meta" style={{ marginBottom: 12 }}>
              Note: {props.activeFocus.note}
            </div>
          )}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="f-end-note">Completion / Worklog Note (optional)</label>
              <input
                id="f-end-note"
                className="input"
                value={finishNote}
                onChange={(e) => setFinishNote(e.target.value)}
                placeholder="What did you accomplish?"
                disabled={busy}
              />
            </div>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={createWorklog}
                onChange={(e) => setCreateWorklog(e.target.checked)}
                disabled={busy}
              />
              <span>Create linked worklog entry</span>
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleFinish('completed')}
              >
                Finish Session
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void handleFinish('interrupted')}
              >
                Interrupt
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Start Focus Block</h2>
          <form onSubmit={handleStart} className="form-grid">
            <div className="field">
              <label htmlFor="f-task">Task (optional)</label>
              <select
                id="f-task"
                className="select"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                disabled={busy}
              >
                <option value="">No linked task</option>
                {openTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-proj">Project (optional)</label>
              <select
                id="f-proj"
                className="select"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={busy}
              >
                <option value="">Inherit / Unassigned</option>
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
              <label htmlFor="f-note">Focus Note (optional)</label>
              <input
                id="f-note"
                className="input"
                value={startNote}
                onChange={(e) => setStartNote(e.target.value)}
                placeholder="Deep work objective"
                disabled={busy}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Start Focus
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Recent Focus Sessions ({props.sessions.length})</h2>
        {props.sessions.length === 0 ? (
          <div className="muted">No focus sessions recorded yet.</div>
        ) : (
          <div className="list">
            {props.sessions.map((s) => (
              <div key={s.id} className="list-item">
                <div>
                  <div className="row">
                    <span
                      className={`badge ${s.status === 'active' ? 'badge-success' : s.status === 'interrupted' ? 'badge-warn' : 'badge-accent'}`}
                    >
                      {s.status}
                    </span>
                    <span className="badge">{s.sourceAgent}</span>
                    {s.durationSeconds !== null && (
                      <span className="item-title">
                        {Math.round(s.durationSeconds / 60)}m ({s.durationSeconds}s)
                      </span>
                    )}
                  </div>
                  <div className="item-meta">
                    {new Date(s.startedAt).toLocaleString()}
                    {s.note ? ` · ${s.note}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
