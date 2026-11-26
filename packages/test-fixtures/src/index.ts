import type { AgentSource, Priority, SettingsDto, TaskStatus } from '@daymark/contracts';

export const FIXED_IDS = {
  projectAlpha: '10000000-0000-4000-8000-000000000001',
  projectBeta: '10000000-0000-4000-8000-000000000002',
  taskOverdueHigh: '20000000-0000-4000-8000-000000000001',
  taskTodayHigh: '20000000-0000-4000-8000-000000000002',
  taskTodayMedium: '20000000-0000-4000-8000-000000000003',
  taskUnestimated: '20000000-0000-4000-8000-000000000004',
  taskLargeExceeds: '20000000-0000-4000-8000-000000000005',
  taskCompleted: '20000000-0000-4000-8000-000000000006',
  focus1: '30000000-0000-4000-8000-000000000001',
  worklog1: '40000000-0000-4000-8000-000000000001',
  tagDeepWork: '50000000-0000-4000-8000-000000000001',
} as const;

export const DEFAULT_TEST_SETTINGS: SettingsDto = {
  timezone: 'Asia/Jakarta',
  weekStartsOn: 'monday',
  dayStartTime: '09:00',
  defaultPlanMinutes: 120,
};

export const DST_SPRING_FORWARD_NY_DATE = '2026-03-08';
export const DST_FALL_BACK_NY_DATE = '2026-11-01';

export interface SampleTaskSeed {
  id: string;
  title: string;
  projectId: string | null;
  status: TaskStatus;
  priority: Priority;
  estimateMinutes: number | null;
  dueDate: string | null;
  dueAtMs: number | null;
  sourceAgent: AgentSource;
}

export const SAMPLE_PLANNING_TASKS: SampleTaskSeed[] = [
  {
    id: FIXED_IDS.taskOverdueHigh,
    title: 'Fix failing migration check',
    projectId: FIXED_IDS.projectAlpha,
    status: 'todo',
    priority: 'medium',
    estimateMinutes: 30,
    dueDate: '2026-11-25',
    dueAtMs: null,
    sourceAgent: 'claude-code',
  },
  {
    id: FIXED_IDS.taskTodayHigh,
    title: 'Implement core planner rules',
    projectId: FIXED_IDS.projectAlpha,
    status: 'in_progress',
    priority: 'high',
    estimateMinutes: 60,
    dueDate: '2026-11-26',
    dueAtMs: null,
    sourceAgent: 'cursor',
  },
  {
    id: FIXED_IDS.taskTodayMedium,
    title: 'Write unit tests for DST bounds',
    projectId: FIXED_IDS.projectAlpha,
    status: 'todo',
    priority: 'medium',
    estimateMinutes: 45,
    dueDate: '2026-11-26',
    dueAtMs: null,
    sourceAgent: 'codex',
  },
  {
    id: FIXED_IDS.taskUnestimated,
    title: 'Clarify license trade-offs',
    projectId: null,
    status: 'todo',
    priority: 'high',
    estimateMinutes: null,
    dueDate: null,
    dueAtMs: null,
    sourceAgent: 'opencode',
  },
  {
    id: FIXED_IDS.taskLargeExceeds,
    title: 'Refactor unrelated module',
    projectId: FIXED_IDS.projectBeta,
    status: 'todo',
    priority: 'low',
    estimateMinutes: 180,
    dueDate: '2026-11-30',
    dueAtMs: null,
    sourceAgent: 'antigravity',
  },
  {
    id: FIXED_IDS.taskCompleted,
    title: 'Initial repository discovery',
    projectId: FIXED_IDS.projectAlpha,
    status: 'completed',
    priority: 'high',
    estimateMinutes: 25,
    dueDate: '2026-11-26',
    dueAtMs: null,
    sourceAgent: 'cli',
  },
];
