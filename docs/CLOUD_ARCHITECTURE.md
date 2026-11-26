# Future Cloud Architecture & Migration Strategy (Phase E)

Daymark currently runs local-first on single-user SQLite (`better-sqlite3`), while preserving clean abstractions so multi-user cloud deployment can be added later without rewriting business logic or creating separate products for CLI, Web, and Remote MCP.

---

## 1. Preserving the Core Storage Interface

All business logic in `@daymark/core` (`domain/` + `application/`) operates strictly against repository and transaction abstractions in [`packages/core/src/storage/ports.ts`](../packages/core/src/storage/ports.ts):

- **Domain core (`packages/core/src/domain/`):** Pure functions for time math (`time.ts`), status transitions and DTO mapping (`rules.ts`), deterministic daily planning (`planner.ts`), and review aggregation (`reviews.ts`). Zero Node `fs`, `path`, `Buffer`, or SQLite dependencies.
- **Synchronous local port (`DaymarkStore`):** Used by local `better-sqlite3` (`@daymark/storage-sqlite`) for CLI, STDIO MCP, local Web Dashboard, and local Remote MCP bridge.
- **Asynchronous cloud-ready port (`AsyncDaymarkStore`):** Defines `Promise`-returning repository ports (`AsyncDaymarkRepositories`), `TenantContext`, `StorageCapabilities`, and `transaction(fn, { tenant })` with **zero local filesystem path methods** (no `getDataDir()`).
- **Bridge adapter (`toAsyncDaymarkStore`):** Adapts any synchronous `DaymarkStore` into `AsyncDaymarkStore` for uniform testing and transition planning.

---

## 2. Tenant Isolation Requirements

When moving from a single-user local SQLite file to a shared multi-user database (Cloudflare D1, Turso, or PostgreSQL):

1. **Trusted Tenant Context from Authentication Only:**
   - `ExecutionContext.tenantId` and `ExecutionContext.principalId` MUST come strictly from verified authentication (`OAuthTokenVerifier` claims or signed session token).
   - Never accept `tenantId`, `userId`, or filesystem paths from MCP tool arguments or HTTP request bodies.
2. **Row-Level Partitioning Across All Tables:**
   - Every table (`projects`, `tasks`, `tags`, `task_tags`, `focus_sessions`, `worklog_entries`, `settings`, `idempotency_records`) requires a non-null `tenant_id` column and indexed queries scoped by `WHERE tenant_id = ?`.
3. **Tenant-Scoped Uniqueness Constraints:**
   - `tags`: change `UNIQUE(name)` -> `UNIQUE(tenant_id, name)`.
   - `settings`: change `PRIMARY KEY(key)` -> `PRIMARY KEY(tenant_id, key)`.
   - `idempotency_records`: change `PRIMARY KEY(scope, idempotency_key)` -> `PRIMARY KEY(tenant_id, scope, idempotency_key)`.
   - `focus_sessions`: change partial unique index from `(status) WHERE status = 'active'` to `(tenant_id, status) WHERE status = 'active'` so one tenant's active focus session never blocks another tenant.
4. **Authorization & Scope Policy:**
   - `@daymark/core`'s `createGuardedDaymarkService` enforces `OPERATION_POLICY` (`read` vs `write` vs `backup`/`destructive`). Cloud adapters must map OAuth scopes directly into `ExecutionContext.scopes` and isolate backup export/import per tenant.

---

## 3. Eliminating Local Filesystem Dependencies in Core

- Cursor pagination (`encodeOffsetCursor` / `decodeOffsetCursor`) uses Web-standard `TextEncoder` / `TextDecoder` + `btoa` / `atob` rather than Node `Buffer`.
- `ExecutionContext.redactLocalPaths = true` blanks `SystemStatus.dataDir` (`null`) for both the Web Dashboard and Remote MCP so local disk layout is never exposed over HTTP.
- Configuration path resolution (`@daymark/config`) stays strictly in local runtime composition roots (`cli`, local `mcp-server`, local `apps/web`), never imported by `@daymark/core`.

---

## 3.1 Distributed Rate Limiting Abstraction

Remote HTTP MCP (`@daymark/mcp-server`) defines a storage-agnostic async `RateLimiter` interface in [`packages/mcp-server/src/rate-limit.ts`](../packages/mcp-server/src/rate-limit.ts):

- **Single-process personal deployments:** Default to `createMemoryRateLimiter(config)` (sliding window in process `Map`), appropriate for localhost + Cloudflare Tunnel on one Node.js process.
- **Multi-instance / SaaS deployments:** Pass a shared external `rateLimiter` implementation to `createDaymarkHttpMcpHandler({ rateLimiter })` / `startDaymarkHttpServer({ rateLimiter })` backed by Redis, Cloudflare Workers KV, or Durable Objects so rate-limit counters and `Retry-After` enforcement synchronize consistently across horizontal server instances.

---

## 4. Why SQLite (`better-sqlite3`) Cannot Be Swapped 1:1 with D1 / Turso Without Adjustments

Even though Cloudflare D1 and Turso speak SQLite SQL syntax, treating them as drop-in replacements for `better-sqlite3` causes real production bugs:

| Dimension | Local `better-sqlite3` | Cloudflare D1 / Turso (libSQL HTTP) | Required Adjustment |
|---|---|---|---|
| **Execution model** | Synchronous in-process C++ binding | Asynchronous network/RPC (`Promise`) | Implement `AsyncDaymarkStore` + async repository adapters; do not assume synchronous `store.transaction(...)` callbacks can `await`. |
| **Transactions** | Interactive synchronous `BEGIN IMMEDIATE ... COMMIT` inside JS callback | D1 has no interactive multi-round-trip transactions across JS `await` (`db.batch()` only); Turso HTTP interactive transactions have network timeouts | Express multi-step atomic mutations (`captureTask` idempotency + insert, `completeTask` + linked worklog) as batched statements, CTEs, or optimistic concurrency checks (`WHERE updated_at = ?`). |
| **Query latency** | Microseconds (in-memory page cache / local NVMe) | 5–50 ms per HTTP round-trip | Eliminate per-row or N+1 repository calls (`hydrateTask` tag lookups); use SQL `JOIN`s / JSON aggregation in cloud repositories. |
| **Concurrency & locking** | OS POSIX file lock (`busy_timeout = 5000`, WAL mode) | Serverless worker isolation / remote HTTP retries | Handle transient remote write contention with idempotent retries (`idempotency_records`) rather than relying on `SQLITE_BUSY` file locks. |
| **Partial unique indexes & pragmas** | SQLite 3.54.1 guaranteed WAL + partial unique index | D1 disables `PRAGMA journal_mode = WAL`; verify `PRAGMA foreign_keys` & partial unique index enforcement per target driver | Validate driver behavior via `driver.integration.test.ts`-style parity tests on the exact cloud target before deployment. |

---

## 5. Migration Strategy (Local SQLite -> Cloud Storage)

1. **Export Verified Snapshot:**
   - User runs `daymark export ./daymark-backup.json` to emit a versioned `BackupArchive` (`formatVersion: 1`, UTC ISO-8601 timestamps, preserved UUIDs, date-only `dueDate`, tags, focus sessions, and worklogs).
2. **Dry-Run Cloud Validation:**
   - Cloud import endpoint parses `BackupArchiveSchema`, verifies `formatVersion`, checks single-active-focus invariant, and assigns `tenant_id` from the authenticated user's session (never from the uploaded archive).
3. **Transactional Tenant Import:**
   - Write snapshot into the target tenant's partition using batched inserts / idempotency tracking without overwriting other tenants.
4. **Optional Future Sync:**
   - Add an opt-in `sync_outbox` / `updated_at` watermark only if cross-device offline-first sync is later introduced, keeping local SQLite usable completely offline.
