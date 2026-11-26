export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

/**
 * Storage-agnostic rate limiter interface for Remote HTTP MCP (`/mcp`).
 * Personal single-node deployments use `createMemoryRateLimiter`;
 * multi-instance / SaaS deployments can plug in Redis, Cloudflare KV,
 * or Durable Object adapters without modifying the HTTP transport.
 */
export interface RateLimiter {
  check(key: string, nowMs: number): Promise<RateLimitDecision> | RateLimitDecision;
}

/**
 * Default in-memory sliding-window rate limiter for single-process local/tunnel deployments.
 */
export function createMemoryRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, number[]>();

  return {
    check(key: string, nowMs: number): RateLimitDecision {
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
    },
  };
}
