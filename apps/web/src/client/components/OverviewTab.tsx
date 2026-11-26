import type { DailyReviewOutput, SystemStatus } from '@daymark/contracts';
import { useState } from 'react';
import { daymarkApi } from '../api';

export function OverviewTab(props: {
  status: SystemStatus;
  review: DailyReviewOutput | null;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
  onNavigate: (
    tab: 'overview' | 'projects' | 'tasks' | 'plan' | 'focus' | 'worklog' | 'weekly',
  ) => void;
}) {
  const { status, review } = props;
  const [quickTitle, setQuickTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleQuickCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!quickTitle.trim()) return;
    setBusy(true);
    try {
      await daymarkApi.captureTask({ title: quickTitle.trim() });
      setQuickTitle('');
      await props.onRefresh();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <div className="muted">
            Shared local SQLite state across CLI, STDIO MCP, Web Dashboard, and Remote MCP
          </div>
        </div>
        <button type="button" className="btn" onClick={() => void props.onRefresh()}>
          Refresh
        </button>
      </div>

      {status.activeFocusSession && (
        <div className="alert">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>Active Focus Session</strong>{' '}
              <span className="badge badge-accent">{status.activeFocusSession.sourceAgent}</span>
              <div className="item-meta">
                Started: {new Date(status.activeFocusSession.startedAt).toLocaleString()}
                {status.activeFocusSession.note ? ` · ${status.activeFocusSession.note}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => props.onNavigate('focus')}
            >
              Manage Focus
            </button>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Completed Today</div>
          <div className="stat-value">{review?.completedTasks.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">In Progress</div>
          <div className="stat-value">{review?.inProgressTasks.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Overdue</div>
          <div className="stat-value">{review?.overdueTasks.length ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Focus Time</div>
          <div className="stat-value">{Math.round((review?.totalFocusSeconds ?? 0) / 60)}m</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Worklog Logged</div>
          <div className="stat-value">{review?.totalWorklogMinutes ?? 0}m</div>
        </div>
      </div>

      <div className="card">
        <h2>Quick Task Capture</h2>
        <form onSubmit={handleQuickCapture} className="row">
          <input
            className="input"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="Capture a task without guessing estimates or due dates..."
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            disabled={busy}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || quickTitle.trim().length === 0}
          >
            Capture Task
          </button>
        </form>
      </div>

      {review && review.dataGaps.length > 0 && (
        <div className="card">
          <h2>Explicit Data Gaps</h2>
          <div className="list">
            {review.dataGaps.map((gap) => (
              <div key={gap} className="item-meta">
                • {gap}
              </div>
            ))}
          </div>
        </div>
      )}

      {review && review.suggestedNextActions.length > 0 && (
        <div className="card">
          <h2>Suggested Next Actions</h2>
          <div className="list">
            {review.suggestedNextActions.map((act) => (
              <div key={`${act.kind}-${act.taskId ?? act.message}`} className="list-item">
                <div>
                  <span className="badge badge-accent">{act.kind}</span>{' '}
                  <span className="item-title">{act.message}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
