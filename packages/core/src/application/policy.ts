import { type AgentSource, DaymarkError } from '@daymark/contracts';
import type { DaymarkService } from './use-cases.js';

export type PermissionScope = 'read' | 'write' | 'backup';

export type DaymarkOperation =
  | 'getStatus'
  | 'listProjects'
  | 'createProject'
  | 'updateProject'
  | 'listTasks'
  | 'getTask'
  | 'captureTask'
  | 'updateTask'
  | 'completeTask'
  | 'getTodayPlan'
  | 'startFocus'
  | 'finishFocus'
  | 'listFocusSessions'
  | 'logWork'
  | 'listWorklog'
  | 'generateDailyReview'
  | 'generateWeeklyReview'
  | 'exportBackup'
  | 'validateImport'
  | 'importBackup';

export interface OperationPolicyRule {
  requiredScope: PermissionScope;
  sensitivity: 'read' | 'write' | 'destructive';
}

export const OPERATION_POLICY: Record<DaymarkOperation, OperationPolicyRule> = {
  getStatus: { requiredScope: 'read', sensitivity: 'read' },
  listProjects: { requiredScope: 'read', sensitivity: 'read' },
  listTasks: { requiredScope: 'read', sensitivity: 'read' },
  getTask: { requiredScope: 'read', sensitivity: 'read' },
  getTodayPlan: { requiredScope: 'read', sensitivity: 'read' },
  listFocusSessions: { requiredScope: 'read', sensitivity: 'read' },
  listWorklog: { requiredScope: 'read', sensitivity: 'read' },
  generateDailyReview: { requiredScope: 'read', sensitivity: 'read' },
  generateWeeklyReview: { requiredScope: 'read', sensitivity: 'read' },
  validateImport: { requiredScope: 'read', sensitivity: 'read' },

  createProject: { requiredScope: 'write', sensitivity: 'write' },
  updateProject: { requiredScope: 'write', sensitivity: 'write' },
  captureTask: { requiredScope: 'write', sensitivity: 'write' },
  updateTask: { requiredScope: 'write', sensitivity: 'write' },
  completeTask: { requiredScope: 'write', sensitivity: 'write' },
  startFocus: { requiredScope: 'write', sensitivity: 'write' },
  finishFocus: { requiredScope: 'write', sensitivity: 'write' },
  logWork: { requiredScope: 'write', sensitivity: 'write' },

  exportBackup: { requiredScope: 'backup', sensitivity: 'read' },
  importBackup: { requiredScope: 'backup', sensitivity: 'destructive' },
};

export interface ExecutionContext {
  principalId: string;
  tenantId: string;
  source: AgentSource;
  scopes: readonly PermissionScope[];
  allowDestructive?: boolean;
  redactLocalPaths?: boolean;
}

export const LOCAL_TRUSTED_CONTEXT: ExecutionContext = {
  principalId: 'local-owner',
  tenantId: 'default',
  source: 'cli',
  scopes: ['read', 'write', 'backup'],
  allowDestructive: true,
  redactLocalPaths: false,
};

export function createWebExecutionContext(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    principalId: overrides.principalId ?? 'local-web-user',
    tenantId: overrides.tenantId ?? 'default',
    source: overrides.source ?? 'web',
    scopes: overrides.scopes ?? ['read', 'write'],
    allowDestructive: overrides.allowDestructive ?? false,
    redactLocalPaths: overrides.redactLocalPaths ?? true,
  };
}

export function createRemoteExecutionContext(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    principalId: overrides.principalId ?? 'remote-bearer',
    tenantId: overrides.tenantId ?? 'default',
    source: overrides.source ?? 'claude-web',
    scopes: overrides.scopes ?? ['read', 'write'],
    allowDestructive: overrides.allowDestructive ?? false,
    redactLocalPaths: overrides.redactLocalPaths ?? true,
  };
}

export function getRequiredScope(operation: DaymarkOperation): PermissionScope {
  return OPERATION_POLICY[operation].requiredScope;
}

export function isOperationAllowed(
  operation: DaymarkOperation,
  context: ExecutionContext,
): boolean {
  const rule = OPERATION_POLICY[operation];
  if (!context.scopes.includes(rule.requiredScope)) {
    return false;
  }
  if (rule.sensitivity === 'destructive' && context.allowDestructive === false) {
    return false;
  }
  return true;
}

export function assertOperationAllowed(
  operation: DaymarkOperation,
  context: ExecutionContext,
): void {
  const rule = OPERATION_POLICY[operation];
  if (!context.scopes.includes(rule.requiredScope)) {
    throw new DaymarkError(
      'FORBIDDEN',
      `Operation "${operation}" requires "${rule.requiredScope}" scope.`,
      {
        nextStep: `Authenticate with a credential granting "${rule.requiredScope}" permission.`,
        details: { operation, requiredScope: rule.requiredScope, principalId: context.principalId },
      },
    );
  }
  if (rule.sensitivity === 'destructive' && context.allowDestructive === false) {
    throw new DaymarkError(
      'FORBIDDEN',
      `Destructive operation "${operation}" is not permitted in this execution context.`,
      {
        nextStep: 'Run this administrative action from the local CLI with explicit confirmation.',
        details: { operation, principalId: context.principalId },
      },
    );
  }
}

/**
 * Wraps the canonical DaymarkService with centralized permission policy checks,
 * default source attribution, and optional local filesystem path redaction.
 * Every interface adapter (CLI, STDIO MCP, Local Web API, Remote HTTP MCP)
 * calls through this single core boundary without duplicating business logic.
 */
export function createGuardedDaymarkService(
  service: DaymarkService,
  context: ExecutionContext,
): DaymarkService {
  function run<K extends DaymarkOperation>(
    operation: K,
    fn: () => ReturnType<DaymarkService[K]>,
  ): ReturnType<DaymarkService[K]> {
    assertOperationAllowed(operation, context);
    return fn();
  }

  return {
    getStatus(input) {
      return run('getStatus', () => {
        const status = service.getStatus(input);
        if (context.redactLocalPaths) {
          return {
            ...status,
            dataDir: null,
          };
        }
        return status;
      });
    },
    listProjects(input) {
      return run('listProjects', () => service.listProjects(input));
    },
    createProject(input) {
      return run('createProject', () => service.createProject(input));
    },
    updateProject(input) {
      return run('updateProject', () => service.updateProject(input));
    },
    listTasks(input) {
      return run('listTasks', () => service.listTasks(input));
    },
    getTask(input) {
      return run('getTask', () => service.getTask(input));
    },
    captureTask(input) {
      return run('captureTask', () =>
        service.captureTask({
          ...input,
          sourceAgent: input.sourceAgent ?? context.source,
        }),
      );
    },
    updateTask(input) {
      return run('updateTask', () => service.updateTask(input));
    },
    completeTask(input) {
      return run('completeTask', () =>
        service.completeTask({
          ...input,
          sourceAgent: input.sourceAgent ?? context.source,
        }),
      );
    },
    getTodayPlan(input) {
      return run('getTodayPlan', () => service.getTodayPlan(input));
    },
    startFocus(input = {}) {
      return run('startFocus', () =>
        service.startFocus({
          ...input,
          sourceAgent: input.sourceAgent ?? context.source,
        }),
      );
    },
    finishFocus(input) {
      return run('finishFocus', () => service.finishFocus(input));
    },
    listFocusSessions(input) {
      return run('listFocusSessions', () => service.listFocusSessions(input));
    },
    logWork(input) {
      return run('logWork', () =>
        service.logWork({
          ...input,
          sourceAgent: input.sourceAgent ?? context.source,
        }),
      );
    },
    listWorklog(input) {
      return run('listWorklog', () => service.listWorklog(input));
    },
    generateDailyReview(input) {
      return run('generateDailyReview', () => service.generateDailyReview(input));
    },
    generateWeeklyReview(input) {
      return run('generateWeeklyReview', () => service.generateWeeklyReview(input));
    },
    exportBackup() {
      return run('exportBackup', () => service.exportBackup());
    },
    validateImport(rawArchive, mode) {
      return run('validateImport', () => service.validateImport(rawArchive, mode));
    },
    importBackup(rawArchive, options) {
      return run('importBackup', () => service.importBackup(rawArchive, options));
    },
  };
}
