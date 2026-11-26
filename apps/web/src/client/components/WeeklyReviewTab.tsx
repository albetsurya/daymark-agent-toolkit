import type { WeeklyReviewOutput } from '@daymark/contracts';
import { useCallback, useEffect, useState } from 'react';
import { daymarkApi } from '../api';

export function WeeklyReviewTab(props: { onError: (err: unknown) => void }) {
  const [weekOf, setWeekOf] = useState('');
  const [review, setReview] = useState<WeeklyReviewOutput | null>(null);
  const [busy, setBusy] = useState(false);

  const loadWeekly = useCallback(
    async (targetDate?: string) => {
      setBusy(true);
      try {
        const res = await daymarkApi.getWeeklyReview(targetDate || undefined);
        setReview(res);
      } catch (err) {
        props.onError(err);
      } finally {
        setBusy(false);
      }
    },
    [props.onError],
  );

  useEffect(() => {
    void loadWeekly();
  }, [loadWeekly]);

  const maxMinutes = review
    ? Math.max(
        1,
        ...review.dailyTotals.map((d) =>
          Math.max(d.worklogMinutes, Math.round(d.focusSeconds / 60)),
        ),
      )
    : 1;

  return (
    <div>
      <div className="page-header">
        <h1>Weekly Review</h1>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void loadWeekly(weekOf);
          }}
        >
          <input
            className="input"
            style={{ width: 160 }}
            type="date"
            value={weekOf}
            onChange={(e) => setWeekOf(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Load Week
          </button>
        </form>
      </div>

      {review && (
        <>
          <div className="alert">
            <strong>
              Week {review.weekStartDate} to {review.weekEndDate}
            </strong>{' '}
            ({review.timezone} · starts on {review.weekStartsOn})
          </div>

          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Completed Tasks</div>
              <div className="stat-value">{review.completedTasks.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">In Progress</div>
              <div className="stat-value">{review.inProgressTasks.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Overdue</div>
              <div className="stat-value">{review.overdueTasks.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Focus</div>
              <div className="stat-value">{Math.round(review.totalFocusSeconds / 60)}m</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Worklog</div>
              <div className="stat-value">{review.totalWorklogMinutes}m</div>
            </div>
          </div>

          <div className="card">
            <h2>Day-by-Day Activity</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Completed</th>
                  <th>Focus</th>
                  <th>Worklog</th>
                  <th style={{ width: '32%' }}>Intensity</th>
                </tr>
              </thead>
              <tbody>
                {review.dailyTotals.map((day) => {
                  const focusMins = Math.round(day.focusSeconds / 60);
                  const pct = Math.min(
                    100,
                    Math.round((Math.max(day.worklogMinutes, focusMins) / maxMinutes) * 100),
                  );
                  return (
                    <tr key={day.date}>
                      <td>{day.date}</td>
                      <td>{day.completedTasksCount}</td>
                      <td>{focusMins}m</td>
                      <td>
                        {day.worklogMinutes}m ({day.worklogCount})
                      </td>
                      <td>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {review.dataGaps.length > 0 && (
            <div className="card">
              <h2>Data Gaps Reported</h2>
              <div className="list">
                {review.dataGaps.map((gap) => (
                  <div key={gap} className="item-meta">
                    • {gap}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
