import { resolveDaymarkPaths } from '@daymark/config';
import { type AgentSource, APP_VERSION } from '@daymark/contracts';
import {
  type Clock,
  createDaymarkService,
  createGuardedDaymarkService,
  type ExecutionContext,
  LOCAL_TRUSTED_CONTEXT,
  systemClock,
} from '@daymark/core';
import { type ManagedDaymarkStore, openDaymarkStore } from '@daymark/storage-sqlite';
import { McpServer } from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import type pino from 'pino';
import {
  createStderrLogger,
  inferAgentSourceFromClientName,
  registerDaymarkTools,
} from './tools.js';

export * from './http.js';
export * from './rate-limit.js';
export * from './tools.js';

export interface DaymarkMcpServerOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  store?: ManagedDaymarkStore;
  logger?: pino.Logger;
  executionContext?: ExecutionContext;
}

export function createDaymarkMcpServer(options: DaymarkMcpServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createStderrLogger(env, 'silent');
  const ownsStore = options.store === undefined;
  const store = options.store ?? openDaymarkStore(resolveDaymarkPaths({ env }));
  const baseService = createDaymarkService({ store, clock: options.clock ?? systemClock });
  const executionContext: ExecutionContext = options.executionContext ?? {
    ...LOCAL_TRUSTED_CONTEXT,
    source: 'other',
    redactLocalPaths: false,
  };
  const guardedService = createGuardedDaymarkService(baseService, executionContext);

  const server = new McpServer(
    { name: 'daymark', version: APP_VERSION },
    { capabilities: { tools: {} } },
  );

  if (ownsStore) {
    server.server.onclose = () => {
      store.close();
    };
  }

  function getClientAgentHint(): AgentSource {
    const clientInfo = server.server.getClientVersion();
    const inferred = inferAgentSourceFromClientName(clientInfo?.name);
    if (inferred === 'unknown' || inferred === 'other') {
      return executionContext.source;
    }
    return inferred;
  }

  registerDaymarkTools(server, guardedService, {
    getAgentSource: getClientAgentHint,
    logger,
    principalId: executionContext.principalId,
  });

  return server;
}

export function startDaymarkStdioServer(options: DaymarkMcpServerOptions = {}): StdioServerHandle {
  return serveStdio(() => createDaymarkMcpServer(options));
}
