import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDaymarkPaths } from '@daymark/config';
import {
  APP_VERSION,
  DaymarkError,
  type ErrorCode,
  type Priority,
  type TaskStatus,
  type WeekStartsOn,
} from '@daymark/contracts';
import {
  type Clock,
  createDaymarkService,
  createGuardedDaymarkService,
  createWebExecutionContext,
  type DaymarkService,
  systemClock,
} from '@daymark/core';
import {
  initializeProfile,
  type ManagedDaymarkStore,
  openDaymarkStore,
} from '@daymark/storage-sqlite';
import pino from 'pino';
import * as z from 'zod';

const MAX_API_BODY_BYTES = 1024 * 1024; // 1 MiB
const CSRF_COOKIE_NAME = 'daymark_csrf_sid';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const InitProfileBodySchema = z
  .object({
    timezone: z.string().trim().min(1).optional(),
    weekStartsOn: z.enum(['monday', 'sunday']).optional(),
    dayStartTime: z.string().trim().optional(),
    defaultPlanMinutes: z.number().int().gt(0).lte(1_440).nullable().optional(),
  })
  .strict();

const CompleteTaskBodySchema = z
  .object({
    completionNote: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export interface DaymarkWebServerOptions {
  host?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  store?: ManagedDaymarkStore;
  clientDistDir?: string;
  allowedOrigins?: string[];
  logger?: pino.Logger;
}

export interface DaymarkWebServerHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createWebLogger(env: Record<string, string | undefined>) {
  return pino(
    {
      level: env.DAYMARK_LOG_LEVEL?.trim() || 'silent',
      redact: {
        paths: [
          'title',
          'description',
          'note',
          'summary',
          'details',
          'completionNote',
          'cookie',
          'csrfToken',
        ],
        remove: true,
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}

export function resolveClientDistDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../client'),
    resolve(here, '../../dist/client'),
    resolve(here, '../../../dist/client'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

function errorCodeToHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_TIME_RANGE':
    case 'INVALID_TIMEZONE':
    case 'BACKUP_VERSION_UNSUPPORTED':
    case 'CONFIRMATION_REQUIRED':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'TASK_NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
    case 'FOCUS_SESSION_NOT_FOUND':
      return 404;
    case 'PROFILE_NOT_INITIALIZED':
    case 'FOCUS_SESSION_ALREADY_ACTIVE':
    case 'FOCUS_SESSION_NOT_ACTIVE':
    case 'INVALID_STATUS_TRANSITION':
    case 'IMPORT_CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'DATABASE_BUSY':
    case 'DATABASE_CORRUPT':
      return 503;
    default:
      return 500;
  }
}

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) return {};
  const cookies: Record<string, string> = {};
  for (const segment of headerValue.split(';')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    const key = segment.slice(0, idx).trim();
    const val = segment.slice(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

function parseHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    return trimmed.slice(0, end + 1);
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_API_BODY_BYTES) {
        if (!settled) {
          settled = true;
          rejectBody(
            new DaymarkError(
              'VALIDATION_FAILED',
              `Request payload exceeds ${MAX_API_BODY_BYTES} bytes.`,
            ),
          );
        }
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new DaymarkError('VALIDATION_FAILED', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectBody(err);
      }
    });
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown, fallbackStatus = 500): void {
  if (err instanceof DaymarkError) {
    sendJson(res, errorCodeToHttpStatus(err.code), {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        nextStep: err.nextStep ?? null,
      },
    });
    return;
  }
  sendJson(res, fallbackStatus, {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
      nextStep: 'Retry the operation or check server diagnostics.',
    },
  });
}

function parseOptionalIntQuery(raw: string | null, label: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new DaymarkError('VALIDATION_FAILED', `Query parameter "${label}" must be an integer.`);
  }
  return n;
}

export function createDaymarkWebRequestHandler(
  options: DaymarkWebServerOptions & { port: number },
) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createWebLogger(env);
  const paths = resolveDaymarkPaths({ env });
  const ownsStore = options.store === undefined;
  const store = options.store ?? openDaymarkStore(paths);
  const baseService = createDaymarkService({ store, clock });
  const service: DaymarkService = createGuardedDaymarkService(
    baseService,
    createWebExecutionContext({ redactLocalPaths: true }),
  );
  const clientDistDir = options.clientDistDir ?? resolveClientDistDir();
  const csrfSecret = randomBytes(32);

  function computeCsrfToken(sessionId: string): string {
    return createHmac('sha256', csrfSecret).update(sessionId, 'utf8').digest('base64url');
  }

  function verifyCsrfToken(sessionId: string, presentedToken: string): boolean {
    const expected = Buffer.from(computeCsrfToken(sessionId), 'utf8');
    const actual = Buffer.from(presentedToken, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  function buildAllowedOrigins(activePort: number): Set<string> {
    const allowed = new Set<string>([
      `http://127.0.0.1:${activePort}`,
      `http://localhost:${activePort}`,
      `http://[::1]:${activePort}`,
      ...(options.allowedOrigins ?? []),
    ]);
    return allowed;
  }

  function isOriginAllowed(origin: string, activePort: number): boolean {
    return buildAllowedOrigins(activePort).has(origin);
  }

  function setSecurityHeaders(res: ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  }

  function serveStaticAsset(pathname: string, res: ServerResponse): void {
    if (!clientDistDir) {
      sendJson(res, 503, {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Dashboard client build not found. Run `pnpm build` first.',
          nextStep: 'Build @daymark/web client assets before starting the dashboard server.',
        },
      });
      return;
    }

    const cleanPath = pathname === '/' ? '/index.html' : pathname;
    const candidate = resolve(clientDistDir, `.${cleanPath}`);
    const rel = relative(clientDistDir, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Invalid asset path.' },
      });
      return;
    }

    let fileToServe = candidate;
    if (!existsSync(fileToServe) || statSync(fileToServe).isDirectory()) {
      // SPA fallback to index.html for client-side routes without file extensions
      if (extname(cleanPath) === '') {
        fileToServe = join(clientDistDir, 'index.html');
      } else {
        sendJson(res, 404, {
          ok: false,
          error: { code: 'VALIDATION_FAILED', message: 'Static asset not found.' },
        });
        return;
      }
    }

    const ext = extname(fileToServe).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = readFileSync(fileToServe);
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader('content-type', mime);
    res.setHeader(
      'cache-control',
      ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    );
    res.end(content);
  }

  async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    activePort: number,
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    const originHeader = req.headers.origin;
    const secFetchSite = req.headers['sec-fetch-site'];

    // 1. Cross-site & Origin checks on all API routes
    if (secFetchSite === 'cross-site') {
      throw new DaymarkError('FORBIDDEN', 'Cross-site requests to the local API are blocked.');
    }
    if (originHeader !== undefined && !isOriginAllowed(originHeader, activePort)) {
      throw new DaymarkError('FORBIDDEN', `Origin "${originHeader}" is not allowed.`);
    }

    // 2. CSRF & strict Origin validation on all mutating methods
    const isMutation =
      method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    if (isMutation) {
      if (!originHeader || !isOriginAllowed(originHeader, activePort)) {
        throw new DaymarkError(
          'FORBIDDEN',
          'Mutating requests require a valid local Origin header.',
          { nextStep: 'Submit requests from the local Daymark dashboard origin.' },
        );
      }
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies[CSRF_COOKIE_NAME];
      const headerTokenRaw = req.headers['x-csrf-token'];
      const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw;
      if (!sid || !headerToken || !verifyCsrfToken(sid, headerToken)) {
        throw new DaymarkError('FORBIDDEN', 'Invalid or missing CSRF protection token.', {
          nextStep: 'Refresh a CSRF token from GET /api/csrf and include X-CSRF-Token.',
        });
      }
    }

    // 3. Route dispatch (all business logic runs strictly through @daymark/core DaymarkService)
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        data: { status: 'ok', service: 'daymark-web', appVersion: APP_VERSION },
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/csrf') {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies[CSRF_COOKIE_NAME] || randomBytes(24).toString('base64url');
      const csrfToken = computeCsrfToken(sid);
      sendJson(
        res,
        200,
        { ok: true, data: { csrfToken } },
        {
          'set-cookie': `${CSRF_COOKIE_NAME}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/`,
        },
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/init') {
      const rawBody = await readJsonBody(req);
      const body = InitProfileBodySchema.parse(rawBody);
      const result = initializeProfile({
        paths,
        timezone: body.timezone,
        weekStartsOn: body.weekStartsOn as WeekStartsOn | undefined,
        dayStartTime: body.dayStartTime,
        defaultPlanMinutes: body.defaultPlanMinutes,
        nowMs: clock.nowMs(),
      });
      sendJson(res, 200, {
        ok: true,
        data: {
          alreadyInitialized: result.alreadyInitialized,
          schemaVersion: result.schemaVersion,
          settings: result.settings,
          appliedMigrations: result.appliedMigrations,
        },
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, { ok: true, data: service.getStatus({}) });
      return;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      const statusParam = url.searchParams.get('status') ?? undefined;
      const limit = parseOptionalIntQuery(url.searchParams.get('limit'), 'limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const out = service.listProjects({
        status: statusParam as 'active' | 'archived' | 'all' | undefined,
        limit,
        cursor,
      });
      sendJson(res, 200, { ok: true, data: out });
      return;
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const body = (await readJsonBody(req)) as Parameters<DaymarkService['createProject']>[0];
      sendJson(res, 201, { ok: true, data: service.createProject(body) });
      return;
    }

    const projectPatchMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (method === 'PATCH' && projectPatchMatch) {
      const projectId = decodeURIComponent(projectPatchMatch[1] ?? '');
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 200, {
        ok: true,
        data: service.updateProject({
          ...body,
          projectId,
        } as Parameters<DaymarkService['updateProject']>[0]),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/tasks') {
      const rawStatuses = url.searchParams.getAll('status');
      const status =
        rawStatuses.length === 0
          ? undefined
          : rawStatuses.length === 1
            ? (rawStatuses[0] as TaskStatus)
            : (rawStatuses as TaskStatus[]);
      const priority = (url.searchParams.get('priority') ?? undefined) as Priority | undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const dueBefore = url.searchParams.get('dueBefore') ?? undefined;
      const dueAfter = url.searchParams.get('dueAfter') ?? undefined;
      const query = url.searchParams.get('query') ?? undefined;
      const limit = parseOptionalIntQuery(url.searchParams.get('limit'), 'limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;

      const out = service.listTasks({
        status,
        priority,
        projectId,
        dueBefore,
        dueAfter,
        query,
        limit,
        cursor,
      });
      sendJson(res, 200, { ok: true, data: out });
      return;
    }

    if (method === 'POST' && pathname === '/api/tasks') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 201, {
        ok: true,
        data: service.captureTask({
          ...body,
          sourceAgent: 'web',
        } as Parameters<DaymarkService['captureTask']>[0]),
      });
      return;
    }

    const taskCompleteMatch = /^\/api\/tasks\/([^/]+)\/complete$/.exec(pathname);
    if (method === 'POST' && taskCompleteMatch) {
      const taskId = decodeURIComponent(taskCompleteMatch[1] ?? '');
      const rawBody = await readJsonBody(req);
      const parsed = CompleteTaskBodySchema.parse(rawBody);
      sendJson(res, 200, {
        ok: true,
        data: service.completeTask({
          taskId,
          completionNote: parsed.completionNote,
          sourceAgent: 'web',
        }),
      });
      return;
    }

    const taskItemMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (taskItemMatch) {
      const taskId = decodeURIComponent(taskItemMatch[1] ?? '');
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, data: service.getTask({ taskId }) });
        return;
      }
      if (method === 'PATCH') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        sendJson(res, 200, {
          ok: true,
          data: service.updateTask({
            ...body,
            taskId,
          } as Parameters<DaymarkService['updateTask']>[0]),
        });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/plan/today') {
      const date = url.searchParams.get('date') ?? undefined;
      const availableMinutes = parseOptionalIntQuery(
        url.searchParams.get('availableMinutes'),
        'availableMinutes',
      );
      sendJson(res, 200, {
        ok: true,
        data: service.getTodayPlan({ date, availableMinutes }),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/focus') {
      const status = (url.searchParams.get('status') ?? undefined) as
        | 'active'
        | 'completed'
        | 'interrupted'
        | 'all'
        | undefined;
      const taskId = url.searchParams.get('taskId') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const limit = parseOptionalIntQuery(url.searchParams.get('limit'), 'limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      sendJson(res, 200, {
        ok: true,
        data: service.listFocusSessions({ status, taskId, projectId, limit, cursor }),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/focus/start') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 201, {
        ok: true,
        data: service.startFocus({
          ...body,
          sourceAgent: 'web',
        } as Parameters<DaymarkService['startFocus']>[0]),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/focus/finish') {
      const body = (await readJsonBody(req)) as Parameters<DaymarkService['finishFocus']>[0];
      sendJson(res, 200, { ok: true, data: service.finishFocus(body) });
      return;
    }

    if (method === 'GET' && pathname === '/api/worklogs') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) {
        throw new DaymarkError(
          'VALIDATION_FAILED',
          'Both "from" and "to" query parameters are required.',
        );
      }
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const taskId = url.searchParams.get('taskId') ?? undefined;
      const limit = parseOptionalIntQuery(url.searchParams.get('limit'), 'limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      sendJson(res, 200, {
        ok: true,
        data: service.listWorklog({ from, to, projectId, taskId, limit, cursor }),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/worklogs') {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      sendJson(res, 201, {
        ok: true,
        data: service.logWork({
          ...body,
          sourceAgent: 'web',
        } as Parameters<DaymarkService['logWork']>[0]),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/reviews/daily') {
      const date = url.searchParams.get('date') ?? undefined;
      sendJson(res, 200, { ok: true, data: service.generateDailyReview({ date }) });
      return;
    }

    if (method === 'GET' && pathname === '/api/reviews/weekly') {
      const weekOf = url.searchParams.get('weekOf') ?? undefined;
      sendJson(res, 200, { ok: true, data: service.generateWeeklyReview({ weekOf }) });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: `API endpoint "${pathname}" was not found.`,
      },
    });
  }

  let boundPort = options.port;

  return {
    setActivePort(port: number) {
      boundPort = port;
    },
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const startMs = Date.now();
      const hostHeader = req.headers.host;
      const parsedHost = parseHostHeader(hostHeader);

      if (!parsedHost || !LOOPBACK_HOSTS.has(parsedHost)) {
        sendJson(res, 403, {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Host header is not an allowed loopback address.',
          },
        });
        return;
      }

      const url = new URL(req.url ?? '/', `http://${hostHeader}`);

      try {
        if (url.pathname.startsWith('/api/')) {
          await handleApiRequest(req, res, url, boundPort);
          logger.debug(
            {
              method: req.method,
              path: url.pathname,
              status: res.statusCode,
              durationMs: Date.now() - startMs,
            },
            'web api request',
          );
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, {
            ok: false,
            error: { code: 'VALIDATION_FAILED', message: 'Method not allowed.' },
          });
          return;
        }
        serveStaticAsset(url.pathname, res);
      } catch (err) {
        if (err instanceof z.ZodError) {
          sendError(
            res,
            new DaymarkError(
              'VALIDATION_FAILED',
              err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
            ),
          );
          return;
        }
        logger.debug(
          {
            method: req.method,
            path: url.pathname,
            err: err instanceof Error ? err.message : 'error',
          },
          'web api error',
        );
        sendError(res, err);
      }
    },
    close() {
      if (ownsStore) {
        store.close();
      }
    },
  };
}

export async function startDaymarkWebServer(
  options: DaymarkWebServerOptions = {},
): Promise<DaymarkWebServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      `Local web dashboard must bind to a loopback host (127.0.0.1, ::1, or localhost), got "${host}".`,
      {
        nextStep:
          'Use host 127.0.0.1 for local dashboard access; expose Remote MCP over Cloudflare Tunnel instead.',
      },
    );
  }

  const requestedPort = options.port ?? 3456;
  const app = createDaymarkWebRequestHandler({ ...options, port: requestedPort });
  const server = createServer((req, res) => {
    void app.handleRequest(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  app.setActivePort(actualPort);

  return {
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
    async close() {
      app.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
