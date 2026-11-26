import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { resolveDaymarkPaths } from '@daymark/config';
import { type AgentSource, APP_VERSION, DaymarkError } from '@daymark/contracts';
import {
  type Clock,
  createRemoteExecutionContext,
  type ExecutionContext,
  LOCAL_TRUSTED_CONTEXT,
  type PermissionScope,
  systemClock,
} from '@daymark/core';
import { type ManagedDaymarkStore, openDaymarkStore } from '@daymark/storage-sqlite';
import {
  type AuthInfo,
  type AuthMetadataOptions,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isJsonContentType,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  originValidationResponse,
  validateHostHeader,
} from '@modelcontextprotocol/server';
import type pino from 'pino';
import { createDaymarkMcpServer } from './index.js';
import { createStderrLogger } from './tools.js';

export interface BearerTokenCredential {
  token: string;
  principalId: string;
  scopes: readonly PermissionScope[];
  tenantId?: string;
  source?: AgentSource;
}

export interface RemoteOAuthConfig {
  resourceServerUrl: string;
  authorizationServers: string[];
  scopesSupported?: PermissionScope[];
  oauthMetadata?: OAuthMetadata;
  verifier: OAuthTokenVerifier;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface DaymarkHttpMcpOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  store?: ManagedDaymarkStore;
  logger?: pino.Logger;
  bearerTokens?: BearerTokenCredential[];
  oauth?: RemoteOAuthConfig;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  allowAnyHost?: boolean;
  rateLimit?: RateLimitConfig;
  maxRequestBodySize?: number;
  endpointPath?: string;
}

export interface DaymarkHttpMcpServerHandle {
  url: string;
  mcpUrl: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeTokenEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256Buffer(a), sha256Buffer(b));
}

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
      },
    },
  );
}

function isHostnameMatch(hostname: string, allowPatterns: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  for (const pattern of allowPatterns) {
    const p = pattern.toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // '.example.com'
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        return true;
      }
    } else if (normalized === p) {
      return true;
    }
  }
  return false;
}

function parseHostWithoutPort(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    return trimmed.slice(0, end + 1);
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
}

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

function createSlidingWindowRateLimiter(config: RateLimitConfig) {
  const buckets = new Map<string, number[]>();

  return function checkLimit(key: string, nowMs: number): RateLimitDecision {
    const cutoff = nowMs - config.windowMs;
    const timestamps = (buckets.get(key) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= config.maxRequests) {
      const oldest = timestamps[0] ?? nowMs;
      const resetAfterSeconds = Math.max(1, Math.ceil((oldest + config.windowMs - nowMs) / 1000));
      buckets.set(key, timestamps);
      return {
        allowed: false,
        limit: config.maxRequests,
        remaining: 0,
        resetAfterSeconds,
      };
    }
    timestamps.push(nowMs);
    buckets.set(key, timestamps);
    if (buckets.size > 1024) {
      for (const [bucketKey, vals] of buckets) {
        if (vals.every((ts) => ts <= cutoff)) {
          buckets.delete(bucketKey);
        }
      }
    }
    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - timestamps.length),
      resetAfterSeconds: Math.ceil(config.windowMs / 1000),
    };
  };
}

function parseEnvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveConfiguredTokens(
  env: Record<string, string | undefined>,
  explicit?: BearerTokenCredential[],
): BearerTokenCredential[] {
  if (explicit) return explicit;
  const out: BearerTokenCredential[] = [];
  const rwToken = env.DAYMARK_MCP_TOKEN?.trim();
  if (rwToken) {
    out.push({
      token: rwToken,
      principalId: 'personal-bearer',
      tenantId: 'default',
      scopes: ['read', 'write'],
      source: 'claude-web',
    });
  }
  const roToken = env.DAYMARK_MCP_READONLY_TOKEN?.trim();
  if (roToken) {
    out.push({
      token: roToken,
      principalId: 'personal-readonly',
      tenantId: 'default',
      scopes: ['read'],
      source: 'claude-web',
    });
  }
  return out;
}

function mapAuthScopes(scopes: readonly string[]): PermissionScope[] {
  const valid = new Set<PermissionScope>();
  for (const s of scopes) {
    if (s === 'read' || s === 'daymark:read') valid.add('read');
    if (s === 'write' || s === 'daymark:write') valid.add('write');
    if (s === 'backup' || s === 'daymark:backup') valid.add('backup');
  }
  if (valid.size === 0) {
    valid.add('read');
  }
  return [...valid];
}

function buildContextFromAuthInfo(
  authInfo: AuthInfo | undefined,
  fallbackSource: AgentSource,
): ExecutionContext {
  const extra = authInfo?.extra as
    | { principalId?: string; tenantId?: string; source?: AgentSource }
    | undefined;
  return createRemoteExecutionContext({
    principalId: extra?.principalId ?? authInfo?.clientId ?? 'remote-authenticated',
    tenantId: extra?.tenantId ?? 'default',
    source: extra?.source ?? fallbackSource,
    scopes: mapAuthScopes(authInfo?.scopes ?? []),
    allowDestructive: false,
    redactLocalPaths: true,
  });
}

export interface DaymarkHttpMcpHandler {
  fetch: (request: Request, meta?: { clientIp?: string }) => Promise<Response>;
  close: () => Promise<void>;
}

/**
 * Creates a Web-standard HTTP handler for Remote MCP over Streamable HTTP (`/mcp`).
 * Enforces authentication (bearer token and/or OAuth verifier), host/origin allowlists,
 * body size limits, content-type validation, rate limiting, structured redacted logging,
 * and centralized core permission checks.
 */
export function createDaymarkHttpMcpHandler(
  options: DaymarkHttpMcpOptions = {},
): DaymarkHttpMcpHandler {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createStderrLogger(env, 'info');
  const endpointPath = options.endpointPath ?? '/mcp';
  const maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_BODY_BYTES;
  const bearerTokens = resolveConfiguredTokens(env, options.bearerTokens);

  if (bearerTokens.length === 0 && !options.oauth) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      'Remote HTTP MCP requires bearer token credentials (DAYMARK_MCP_TOKEN) or an OAuth verifier.',
      {
        nextStep:
          'Set DAYMARK_MCP_TOKEN (at least 16 chars recommended) or pass bearerTokens / oauth verifier options.',
      },
    );
  }

  const ownsStore = options.store === undefined;
  const store = options.store ?? openDaymarkStore(resolveDaymarkPaths({ env }));

  const allowedHosts = [
    ...localhostAllowedHostnames(),
    ...parseEnvList(env.DAYMARK_MCP_ALLOWED_HOSTS),
    ...(options.allowedHosts ?? []),
  ];
  const allowedOrigins = [
    ...localhostAllowedOrigins(),
    'claude.ai',
    ...parseEnvList(env.DAYMARK_MCP_ALLOWED_ORIGINS),
    ...(options.allowedOrigins ?? []),
  ];

  const rateLimitCfg: RateLimitConfig = options.rateLimit ?? {
    windowMs: Number(env.DAYMARK_MCP_RATE_LIMIT_WINDOW_MS) || DEFAULT_RATE_LIMIT_WINDOW_MS,
    maxRequests: Number(env.DAYMARK_MCP_RATE_LIMIT_MAX) || DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  };
  const checkRateLimit = createSlidingWindowRateLimiter(rateLimitCfg);

  const authMetadataOptions: AuthMetadataOptions | null = options.oauth
    ? {
        resourceServerUrl: new URL(options.oauth.resourceServerUrl),
        oauthMetadata: options.oauth.oauthMetadata ?? {
          issuer: options.oauth.authorizationServers[0] ?? options.oauth.resourceServerUrl,
          authorization_endpoint: `${options.oauth.authorizationServers[0] ?? ''}/authorize`,
          token_endpoint: `${options.oauth.authorizationServers[0] ?? ''}/token`,
          response_types_supported: ['code'],
        },
        scopesSupported: options.oauth.scopesSupported ?? ['read', 'write'],
        resourceName: 'Daymark Agent Toolkit MCP',
      }
    : null;

  if (authMetadataOptions) {
    // Fail fast at startup if OAuth issuer/resource configuration is invalid
    buildOAuthProtectedResourceMetadata(authMetadataOptions);
  }

  const mcpHandler = createMcpHandler(
    (ctx) => {
      const execContext = buildContextFromAuthInfo(ctx.authInfo, 'claude-web');
      return createDaymarkMcpServer({
        env,
        clock,
        store,
        logger,
        executionContext: execContext,
      });
    },
    {
      legacy: 'stateless',
      maxRequestBodySize,
      onerror: (err) => {
        logger.error({ err: err.message }, 'mcp http handler error');
      },
    },
  );

  async function authenticate(request: Request): Promise<AuthInfo | Response> {
    const authHeader = request.headers.get('authorization');
    const wwwAuthBase = authMetadataOptions
      ? `Bearer realm="daymark-mcp", resource_metadata="${getOAuthProtectedResourceMetadataUrl(authMetadataOptions.resourceServerUrl)}"`
      : 'Bearer realm="daymark-mcp"';

    if (!authHeader) {
      return jsonErrorResponse(401, 'UNAUTHORIZED', 'Missing Authorization bearer token.', {
        'www-authenticate': wwwAuthBase,
      });
    }
    const parts = authHeader.split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      return jsonErrorResponse(401, 'UNAUTHORIZED', 'Authorization header must use Bearer token.', {
        'www-authenticate': `${wwwAuthBase}, error="invalid_request"`,
      });
    }
    const presented = parts[1];

    for (const cred of bearerTokens) {
      if (constantTimeTokenEquals(presented, cred.token)) {
        return {
          token: presented,
          clientId: cred.principalId,
          scopes: [...cred.scopes],
          extra: {
            principalId: cred.principalId,
            tenantId: cred.tenantId ?? 'default',
            source: cred.source ?? 'claude-web',
          },
        };
      }
    }

    if (options.oauth) {
      try {
        const verified = await options.oauth.verifier.verifyAccessToken(presented);
        return verified;
      } catch {
        return jsonErrorResponse(401, 'UNAUTHORIZED', 'Invalid or expired OAuth access token.', {
          'www-authenticate': `${wwwAuthBase}, error="invalid_token"`,
        });
      }
    }

    return jsonErrorResponse(401, 'UNAUTHORIZED', 'Invalid bearer token.', {
      'www-authenticate': `${wwwAuthBase}, error="invalid_token"`,
    });
  }

  return {
    async fetch(request: Request, meta?: { clientIp?: string }): Promise<Response> {
      const startMs = Date.now();
      const url = new URL(request.url);
      const pathname = url.pathname;

      // 1. Validate Host header unless explicitly opted out
      if (!options.allowAnyHost) {
        const hostHeader = request.headers.get('host');
        const exactCheck = validateHostHeader(hostHeader, allowedHosts);
        if (!exactCheck.ok) {
          const parsedHost = hostHeader ? parseHostWithoutPort(hostHeader) : null;
          if (!parsedHost || !isHostnameMatch(parsedHost, allowedHosts)) {
            logger.warn({ path: pathname, status: 403 }, 'rejected host header');
            return jsonErrorResponse(403, 'FORBIDDEN', 'Host header is not allowlisted.');
          }
        }
      }

      // 2. Origin check when Origin header is present (browser requests)
      if (request.headers.has('origin')) {
        const originCheck = originValidationResponse(request, allowedOrigins);
        if (originCheck) {
          logger.warn({ path: pathname, status: 403 }, 'rejected origin header');
          return originCheck;
        }
      }

      // 3. Health & OAuth Protected Resource Metadata endpoints (no DB exposure)
      if (request.method === 'GET' && pathname === '/healthz') {
        return new Response(
          JSON.stringify({
            ok: true,
            service: 'daymark-mcp',
            version: APP_VERSION,
            transport: 'streamable-http',
            endpoint: endpointPath,
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      }

      if (authMetadataOptions && pathname.startsWith('/.well-known/')) {
        const metaRes = oauthMetadataResponse(request, authMetadataOptions);
        if (metaRes) return metaRes;
      }

      // 4. Reject any unknown route (including any hypothetical /db, /sqlite, /export paths)
      if (pathname !== endpointPath) {
        return jsonErrorResponse(404, 'NOT_FOUND', 'Endpoint not found.');
      }

      // 5. Authentication
      const authResult = await authenticate(request);
      if (authResult instanceof Response) {
        logger.warn({ path: pathname, method: request.method, status: 401 }, 'unauthorized access');
        return authResult;
      }

      // 6. Rate limiting keyed by principal + IP hash
      const rateKey = `${authResult.clientId}:${meta?.clientIp ?? 'unknown'}`;
      const limit = checkRateLimit(rateKey, clock.nowMs());
      const rateHeaders = {
        'x-ratelimit-limit': String(limit.limit),
        'x-ratelimit-remaining': String(limit.remaining),
      };
      if (!limit.allowed) {
        logger.warn(
          {
            path: pathname,
            principalId: authResult.clientId,
            status: 429,
          },
          'rate limit exceeded',
        );
        return jsonErrorResponse(
          429,
          'RATE_LIMITED',
          'Too many requests. Retry after the rate-limit window resets.',
          {
            ...rateHeaders,
            'retry-after': String(limit.resetAfterSeconds),
          },
        );
      }

      // 7. Request Content-Type & size validation before dispatching to MCP handler
      if (request.method === 'POST') {
        const contentLengthRaw = request.headers.get('content-length');
        if (contentLengthRaw !== null) {
          const contentLength = Number(contentLengthRaw);
          if (Number.isFinite(contentLength) && contentLength > maxRequestBodySize) {
            return jsonErrorResponse(
              413,
              'VALIDATION_FAILED',
              `Request body exceeds maximum size of ${maxRequestBodySize} bytes.`,
              rateHeaders,
            );
          }
        }
        if (!isJsonContentType(request.headers.get('content-type'))) {
          return jsonErrorResponse(
            415,
            'VALIDATION_FAILED',
            'Content-Type must be application/json.',
            rateHeaders,
          );
        }
      }

      // 8. Dispatch to MCP Streamable HTTP handler
      const rawBodyBuffer =
        request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE'
          ? undefined
          : Buffer.from(await request.arrayBuffer());

      if (rawBodyBuffer && rawBodyBuffer.byteLength > maxRequestBodySize) {
        return jsonErrorResponse(
          413,
          'VALIDATION_FAILED',
          `Request body exceeds maximum size of ${maxRequestBodySize} bytes.`,
          rateHeaders,
        );
      }

      const forwardReq = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: rawBodyBuffer,
        signal: request.signal,
      });

      const response = await mcpHandler.fetch(forwardReq, { authInfo: authResult });
      const headers = new Headers(response.headers);
      headers.set('x-ratelimit-limit', rateHeaders['x-ratelimit-limit']);
      headers.set('x-ratelimit-remaining', rateHeaders['x-ratelimit-remaining']);
      headers.set('x-content-type-options', 'nosniff');

      logger.info(
        {
          method: request.method,
          path: pathname,
          status: response.status,
          principalId: authResult.clientId,
          durationMs: Date.now() - startMs,
        },
        'mcp http request handled',
      );

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },

    async close(): Promise<void> {
      await mcpHandler.close();
      if (ownsStore) {
        store.close();
      }
    },
  };
}

function readNodeRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          rejectBody(
            new DaymarkError(
              'VALIDATION_FAILED',
              `Request body exceeds maximum size of ${maxBytes} bytes.`,
            ),
          );
        }
        return;
      }
      if (!settled) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolveBody(Buffer.concat(chunks));
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

async function writeWebResponseToNode(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!webRes.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(
    webRes.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
  );
  await new Promise<void>((resolveStream, rejectStream) => {
    nodeStream.on('error', rejectStream);
    res.on('close', resolveStream);
    res.on('finish', resolveStream);
    nodeStream.pipe(res);
  });
}

export interface StartHttpMcpServerOptions extends DaymarkHttpMcpOptions {
  host?: string;
  port?: number;
}

export async function startDaymarkHttpServer(
  options: StartHttpMcpServerOptions = {},
): Promise<DaymarkHttpMcpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const endpointPath = options.endpointPath ?? '/mcp';
  const maxBody = options.maxRequestBodySize ?? DEFAULT_MAX_BODY_BYTES;
  const handler = createDaymarkHttpMcpHandler(options);

  const server = createServer(async (req, res) => {
    try {
      const reqHost = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? '/', `http://${reqHost}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else {
          headers.set(k, v);
        }
      }

      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          ac.abort();
        }
      });

      let body: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        const rawContentLen = req.headers['content-length'];
        const declaredLen = rawContentLen !== undefined ? Number(rawContentLen) : NaN;
        if (Number.isFinite(declaredLen) && declaredLen > maxBody) {
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('connection', 'close');
          res.end(
            JSON.stringify({
              error: {
                code: 'VALIDATION_FAILED',
                message: `Request body exceeds maximum size of ${maxBody} bytes.`,
              },
            }),
          );
          req.resume();
          return;
        }
        try {
          body = await readNodeRequestBody(req, maxBody);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Request body too large.';
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('connection', 'close');
          res.end(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message } }));
          return;
        }
      }

      const webReq = new Request(url, {
        method: req.method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: ac.signal,
      });

      const webRes = await handler.fetch(webReq, { clientIp: req.socket.remoteAddress });
      await writeWebResponseToNode(webRes, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'Internal server error.',
            },
          }),
        );
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    url: baseUrl,
    mcpUrl: `${baseUrl}${endpointPath}`,
    host,
    port: actualPort,
    async close() {
      await handler.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

export { LOCAL_TRUSTED_CONTEXT };
