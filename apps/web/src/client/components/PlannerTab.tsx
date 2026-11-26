import type { GetTodayPlanOutput } from '@daymark/contracts';
import { useState } from 'react';
import { daymarkApi } from '../api';

export function PlannerTab(props: {
  onStartFocusForTask: (taskId: string) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [availableMinutes, setAvailableMinutes] = useState('120');
  const [date, setDate] = useState('');
  const [plan, setPlan] = useState<GetTodayPlanOutput | null>(null);
  const [busy, setBusy] = useState(false);

  async function generatePlan(e: React.FormEvent) {
    e.preventDefault();
    const mins = Number(availableMinutes);
    if (!Number.isInteger(mins) || mins < 0) return;
    setBusy(true);
    try {
      const out = await daymarkApi.getTodayPlan({
        availableMinutes: mins,
        date: date || undefined,
      });
      setPlan(out);
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Daily Planning</h1>
      </div>

      <div className="card">
        <h2>Explicit Minute Budget</h2>
        <form onSubmit={generatePlan} className="form-grid">
          <div className="field">
            <label htmlFor="p-mins">Available Minutes Today</label>
            <input
              id="p-mins"
              className="input"
              type="number"
              min={0}
              max={1440}
              value={availableMinutes}
              onChange={(e) => setAvailableMinutes(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="p-date">Date (optional, defaults to profile today)</label>
            <input
              id="p-date"
              className="input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Generate Deterministic Plan
          </button>
        </form>
      </div>

      {plan && (
        <>
          <div className="alert">
            <strong>
              Plan for {plan.date} ({plan.timezone}):
            </strong>{' '}
            {plan.totalEstimatedMinutes} / {plan.availableMinutes} min allocated (
            {plan.remainingMinutes} min remaining) · {plan.overdueCount} overdue
            <div className="item-meta">{plan.disclaimer}</div>
          </div>

          <div className="card">
            <h2>Scheduled Within Budget ({plan.plannedTasks.length})</h2>
            {plan.plannedTasks.length === 0 ? (
              <div className="muted">No estimated open tasks fit inside this budget.</div>
            ) : (
              <div className="list">
                {plan.plannedTasks.map((item) => (
                  <div key={item.task.id} className="list-item">
                    <div>
                      <div className="row">
                        <span className="badge badge-accent">#{item.rank}</span>
                        <span className="item-title">{item.task.title}</span>
                        <span className="badge">{item.task.estimateMinutes}m</span>
                        {item.isOverdue && <span className="badge badge-danger">OVERDUE</span>}
                      </div>
                      <div className="item-meta">{item.explanation}</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void props.onStartFocusForTask(item.task.id)}
                    >
                      Start Focus
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Unscheduled — Missing Estimate ({plan.unscheduledMissingEstimate.length})</h2>
            {plan.unscheduledMissingEstimate.length === 0 ? (
              <div className="muted">All open tasks have estimates.</div>
            ) : (
              <div className="list">
                {plan.unscheduledMissingEstimate.map((item) => (
                  <div key={item.task.id} className="list-item">
                    <div>
                      <div className="item-title">{item.task.title}</div>
                      <div className="item-meta">{item.explanation}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {plan.excludedTasks.length > 0 && (
            <div className="card">
              <h2>Excluded — Exceeds Remaining Budget ({plan.excludedTasks.length})</h2>
              <div className="list">
                {plan.excludedTasks.map((item) => (
                  <div key={item.task.id} className="list-item">
                    <div>
                      <div className="item-title">
                        {item.task.title} ({item.task.estimateMinutes}m)
                      </div>
                      <div className="item-meta">{item.explanation}</div>
                    </div>
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
