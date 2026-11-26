import type {
  DailyReviewOutput,
  FocusSessionDto,
  ProjectDto,
  SystemStatus,
  TaskSummaryDto,
} from '@daymark/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, daymarkApi } from './api';
import { FocusTab } from './components/FocusTab';
import { OverviewTab } from './components/OverviewTab';
import { PlannerTab } from './components/PlannerTab';
import { ProjectsTab } from './components/ProjectsTab';
import { TasksTab } from './components/TasksTab';
import { WeeklyReviewTab } from './components/WeeklyReviewTab';
import { WorklogTab } from './components/WorklogTab';

type TabKey = 'overview' | 'projects' | 'tasks' | 'plan' | 'focus' | 'worklog' | 'weekly';

const NAV_ITEMS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'projects', label: 'Projects' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'plan', label: 'Daily Plan' },
  { key: 'focus', label: 'Focus Session' },
  { key: 'worklog', label: 'Worklog' },
  { key: 'weekly', label: 'Weekly Review' },
];

export function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [tasks, setTasks] = useState<TaskSummaryDto[]>([]);
  const [sessions, setSessions] = useState<FocusSessionDto[]>([]);
  const [dailyReview, setDailyReview] = useState<DailyReviewOutput | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initTimezone, setInitTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiClientError) {
      setErrorMsg(
        err.nextStep
          ? `${err.code}: ${err.message} (${err.nextStep})`
          : `${err.code}: ${err.message}`,
      );
      return;
    }
    setErrorMsg(err instanceof Error ? err.message : 'Unexpected error occurred.');
  }, []);

  const refreshAll = useCallback(async () => {
    setErrorMsg(null);
    try {
      const s = await daymarkApi.getStatus();
      setStatus(s);
      if (!s.initialized) {
        setProjects([]);
        setTasks([]);
        setSessions([]);
        setDailyReview(null);
        return;
      }
      const [projRes, taskRes, focusRes, reviewRes] = await Promise.all([
        daymarkApi.listProjects('all'),
        daymarkApi.listTasks({ limit: 100 }),
        daymarkApi.listFocusSessions('all'),
        daymarkApi.getDailyReview(),
      ]);
      setProjects(projRes.projects);
      setTasks(taskRes.tasks);
      setSessions(focusRes.sessions);
      setDailyReview(reviewRes);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function handleInitializeProfile(e: React.FormEvent) {
    e.preventDefault();
    try {
      await daymarkApi.initProfile({ timezone: initTimezone.trim() || 'UTC' });
      await refreshAll();
    } catch (err) {
      handleError(err);
    }
  }

  async function handleStartFocusForTask(taskId: string) {
    try {
      await daymarkApi.startFocus({ taskId });
      await refreshAll();
      setActiveTab('focus');
    } catch (err) {
      handleError(err);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-title">Daymark</span>
          <span className="brand-subtitle">Local-first Web Dashboard</span>
        </div>

        <nav className="nav-list" aria-label="Dashboard sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-btn ${activeTab === item.key ? 'active' : ''}`}
              onClick={() => setActiveTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-meta">
          <div>
            Profile: <strong>{status?.initialized ? 'Initialized' : 'Not initialized'}</strong>
          </div>
          {status?.timezone && (
            <div>
              Timezone: <strong>{status.timezone}</strong>
            </div>
          )}
          {status?.schemaVersion && (
            <div>
              Schema: <code>{status.schemaVersion}</code>
            </div>
          )}
          <div>API Bound: 127.0.0.1</div>
        </div>
      </aside>

      <main className="main-area">
        {errorMsg && (
          <div className="alert alert-error" role="alert">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{errorMsg}</span>
              <button type="button" className="btn btn-sm" onClick={() => setErrorMsg(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {loading && <div className="card">Loading Daymark profile...</div>}

        {!loading && status && !status.initialized && (
          <div className="card">
            <h2>Initialize Local Daymark Profile</h2>
            <p className="muted">
              No SQLite profile has been initialized yet. Initializing creates your local Daymark
              database with owner-only permissions shared with the CLI and MCP servers.
            </p>
            <form onSubmit={handleInitializeProfile} className="row">
              <input
                className="input"
                style={{ maxWidth: 260 }}
                value={initTimezone}
                onChange={(e) => setInitTimezone(e.target.value)}
                placeholder="IANA Timezone (e.g. Asia/Jakarta)"
              />
              <button type="submit" className="btn btn-primary">
                Initialize Profile
              </button>
            </form>
          </div>
        )}

        {!loading && status?.initialized && (
          <>
            {activeTab === 'overview' && (
              <OverviewTab
                status={status}
                review={dailyReview}
                onRefresh={refreshAll}
                onError={handleError}
                onNavigate={setActiveTab}
              />
            )}
            {activeTab === 'projects' && (
              <ProjectsTab projects={projects} onRefresh={refreshAll} onError={handleError} />
            )}
            {activeTab === 'tasks' && (
              <TasksTab
                tasks={tasks}
                projects={projects}
                onRefresh={refreshAll}
                onError={handleError}
              />
            )}
            {activeTab === 'plan' && (
              <PlannerTab onStartFocusForTask={handleStartFocusForTask} onError={handleError} />
            )}
            {activeTab === 'focus' && (
              <FocusTab
                activeFocus={status.activeFocusSession}
                sessions={sessions}
                tasks={tasks}
                projects={projects}
                onRefresh={refreshAll}
                onError={handleError}
              />
            )}
            {activeTab === 'worklog' && (
              <WorklogTab
                projects={projects}
                tasks={tasks}
                onRefreshGlobal={refreshAll}
                onError={handleError}
              />
            )}
            {activeTab === 'weekly' && <WeeklyReviewTab onError={handleError} />}
          </>
        )}
      </main>
    </div>
  );
}
