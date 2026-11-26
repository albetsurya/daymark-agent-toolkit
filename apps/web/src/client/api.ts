import type {
  CaptureTaskInput,
  CaptureTaskOutput,
  CompleteTaskOutput,
  CreateProjectInput,
  CreateProjectOutput,
  DailyReviewOutput,
  FinishFocusInput,
  FinishFocusOutput,
  GetTodayPlanOutput,
  ListFocusSessionsOutput,
  ListProjectsOutput,
  ListTasksOutput,
  ListWorklogOutput,
  LogWorkInput,
  LogWorkOutput,
  Priority,
  StartFocusInput,
  StartFocusOutput,
  SystemStatus,
  TaskStatus,
  UpdateProjectOutput,
  UpdateTaskOutput,
  WeeklyReviewOutput,
} from '@daymark/contracts';

export interface ApiErrorInfo {
  code: string;
  message: string;
  nextStep?: string | null;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly nextStep: string | null;
  readonly status: number;

  constructor(status: number, info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = info.code;
    this.nextStep = info.nextStep ?? null;
  }
}

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorInfo };

let cachedCsrfToken: string | null = null;

async function ensureCsrfToken(forceRefresh = false): Promise<string> {
  if (cachedCsrfToken && !forceRefresh) {
    return cachedCsrfToken;
  }
  const res = await fetch('/api/csrf', {
    method: 'GET',
    credentials: 'same-origin',
  });
  const json = (await res.json()) as ApiEnvelope<{ csrfToken: string }>;
  if (!res.ok || !json.ok) {
    throw new ApiClientError(
      res.status,
      json.ok ? { code: 'INTERNAL_ERROR', message: 'Failed to obtain CSRF token.' } : json.error,
    );
  }
  cachedCsrfToken = json.data.csrfToken;
  return cachedCsrfToken;
}

async function requestApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  retryCsrf = true,
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  const isMutation = method !== 'GET';

  if (isMutation) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = await ensureCsrfToken(false);
  }

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: isMutation ? JSON.stringify(options.body ?? {}) : undefined,
  });

  const payload = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !payload.ok) {
    const err = payload.ok
      ? { code: 'INTERNAL_ERROR', message: 'Unexpected server response.' }
      : payload.error;
    if (isMutation && res.status === 403 && retryCsrf && /csrf/i.test(err.message)) {
      cachedCsrfToken = null;
      await ensureCsrfToken(true);
      return requestApi<T>(path, options, false);
    }
    throw new ApiClientError(res.status, err);
  }
  return payload.data;
}

function toQueryString(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) search.append(k, item);
    } else {
      search.set(k, String(v));
    }
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

export const daymarkApi = {
  getStatus: () => requestApi<SystemStatus>('/api/status'),

  initProfile: (input: { timezone?: string; defaultPlanMinutes?: number | null }) =>
    requestApi<{ alreadyInitialized: boolean; schemaVersion: string }>('/api/init', {
      method: 'POST',
      body: input,
    }),

  listProjects: (status: 'active' | 'archived' | 'all' = 'all') =>
    requestApi<ListProjectsOutput>(`/api/projects${toQueryString({ status, limit: 100 })}`),

  createProject: (input: CreateProjectInput) =>
    requestApi<CreateProjectOutput>('/api/projects', { method: 'POST', body: input }),

  updateProject: (
    projectId: string,
    patch: { name?: string; description?: string | null; status?: 'active' | 'archived' },
  ) =>
    requestApi<UpdateProjectOutput>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: patch,
    }),

  listTasks: (filter?: {
    status?: TaskStatus[];
    priority?: Priority;
    projectId?: string;
    query?: string;
    limit?: number;
  }) =>
    requestApi<ListTasksOutput>(
      `/api/tasks${toQueryString({
        status: filter?.status,
        priority: filter?.priority,
        projectId: filter?.projectId,
        query: filter?.query,
        limit: filter?.limit ?? 100,
      })}`,
    ),

  captureTask: (input: Omit<CaptureTaskInput, 'sourceAgent'>) =>
    requestApi<CaptureTaskOutput>('/api/tasks', { method: 'POST', body: input }),

  updateTask: (
    taskId: string,
    patch: {
      title?: string;
      description?: string | null;
      projectId?: string | null;
      priority?: Priority;
      estimateMinutes?: number | null;
      dueAt?: string | null;
      status?: TaskStatus;
      tags?: string[];
    },
  ) =>
    requestApi<UpdateTaskOutput>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: patch,
    }),

  completeTask: (taskId: string, completionNote?: string) =>
    requestApi<CompleteTaskOutput>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      body: completionNote ? { completionNote } : {},
    }),

  getTodayPlan: (params: { date?: string; availableMinutes?: number }) =>
    requestApi<GetTodayPlanOutput>(`/api/plan/today${toQueryString(params)}`),

  listFocusSessions: (status: 'active' | 'completed' | 'interrupted' | 'all' = 'all') =>
    requestApi<ListFocusSessionsOutput>(`/api/focus${toQueryString({ status, limit: 30 })}`),

  startFocus: (input: Omit<StartFocusInput, 'sourceAgent'>) =>
    requestApi<StartFocusOutput>('/api/focus/start', { method: 'POST', body: input }),

  finishFocus: (input: FinishFocusInput) =>
    requestApi<FinishFocusOutput>('/api/focus/finish', { method: 'POST', body: input }),

  listWorklogs: (params: { from: string; to: string; projectId?: string }) =>
    requestApi<ListWorklogOutput>(`/api/worklogs${toQueryString({ ...params, limit: 100 })}`),

  logWork: (input: Omit<LogWorkInput, 'sourceAgent'>) =>
    requestApi<LogWorkOutput>('/api/worklogs', { method: 'POST', body: input }),

  getDailyReview: (date?: string) =>
    requestApi<DailyReviewOutput>(`/api/reviews/daily${toQueryString({ date })}`),

  getWeeklyReview: (weekOf?: string) =>
    requestApi<WeeklyReviewOutput>(`/api/reviews/weekly${toQueryString({ weekOf })}`),
};
