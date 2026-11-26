import type { ListWorklogOutput, ProjectDto, TaskSummaryDto } from '@daymark/contracts';
import { useCallback, useEffect, useState } from 'react';
import { daymarkApi } from '../api';

export function WorklogTab(props: {
  projects: ProjectDto[];
  tasks: TaskSummaryDto[];
  onRefreshGlobal: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [fromDate, setFromDate] = useState('2026-01-01');
  const [toDate, setToDate] = useState('2027-12-31');
  const [data, setData] = useState<ListWorklogOutput | null>(null);
  const [summary, setSummary] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('');
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);

  const loadWorklogs = useCallback(async () => {
    try {
      const res = await daymarkApi.listWorklogs({ from: fromDate, to: toDate });
      setData(res);
    } catch (err) {
      props.onError(err);
    }
  }, [fromDate, toDate, props.onError]);

  useEffect(() => {
    void loadWorklogs();
  }, [loadWorklogs]);

  async function handleLogWork(e: React.FormEvent) {
    e.preventDefault();
    if (!summary.trim()) return;
    setBusy(true);
    try {
      const dur = durationMinutes.trim() ? Number(durationMinutes.trim()) : undefined;
      await daymarkApi.logWork({
        summary: summary.trim(),
        durationMinutes: dur,
        projectId: projectId || undefined,
        taskId: taskId || undefined,
      });
      setSummary('');
      setDurationMinutes('');
      await loadWorklogs();
      await props.onRefreshGlobal();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Worklog</h1>
        <div className="row">
          <input
            className="input"
            style={{ width: 150 }}
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
          <span className="muted">to</span>
          <input
            className="input"
            style={{ width: 150 }}
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
          <button type="button" className="btn" onClick={() => void loadWorklogs()}>
            Filter
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Log Explicit Completed Work</h2>
        <form onSubmit={handleLogWork} className="form-grid">
          <div className="field">
            <label htmlFor="w-sum">Summary</label>
            <input
              id="w-sum"
              className="input"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Completed work summary"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="w-dur">Duration mins (optional)</label>
            <input
              id="w-dur"
              className="input"
              type="number"
              min={0}
              max={1440}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              placeholder="e.g. 30"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="w-proj">Project (optional)</label>
            <select
              id="w-proj"
              className="select"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={busy}
            >
              <option value="">None</option>
              {props.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="w-task">Task (optional)</label>
            <select
              id="w-task"
              className="select"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              disabled={busy}
            >
              <option value="">None</option>
              {props.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || summary.trim().length === 0}
          >
            Log Work
          </button>
        </form>
      </div>

      {data && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Entries ({data.totalEntries})</h2>
            <div className="muted">
              Total logged: <strong>{data.totalDurationMinutes}m</strong> · Without duration:{' '}
              {data.entriesWithoutDuration}
            </div>
          </div>
          {data.entries.length === 0 ? (
            <div className="muted">No worklog entries found in this date range.</div>
          ) : (
            <div className="list">
              {data.entries.map((entry) => (
                <div key={entry.id} className="list-item">
                  <div>
                    <div className="row">
                      <span className="item-title">{entry.summary}</span>
                      {entry.durationMinutes !== null && (
                        <span className="badge badge-accent">{entry.durationMinutes}m</span>
                      )}
                      <span className="badge">{entry.sourceAgent}</span>
                    </div>
                    <div className="item-meta">
                      {new Date(entry.occurredAt).toLocaleString()}
                      {entry.details ? ` · ${entry.details}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
