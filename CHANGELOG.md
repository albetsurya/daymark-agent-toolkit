# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.0] - 2026-11-26

### Added
- **Shared Core Architecture (`@daymark/core`, `ADR-013`)**: Separated `domain/` (pure planner, reviews, task transition validation, DST-aware IANA timezone math), `storage/` (`DaymarkStore` + cloud-ready `AsyncDaymarkStore` + `TenantContext`), and `application/` (`ExecutionContext`, `PermissionPolicy`, `createGuardedDaymarkService`) with zero filesystem path or Node `Buffer` dependencies in core.
- **Standalone Web Dashboard (`@daymark/web`, `apps/web`)**: React 19 + TypeScript SPA backed by a loopback-only (`127.0.0.1`) Node HTTP API (`daymark-web`) with `Host`/`Origin` validation, HMAC CSRF protection, and Overview, Projects, Tasks, Daily Plan, Focus Session, Worklog, and Weekly Review views.
- **Remote Streamable HTTP MCP (`@daymark/mcp-server`)**: Added `/mcp` Streamable HTTP adapter (`daymark-mcp --http`) using `@modelcontextprotocol/server` `createMcpHandler`, Bearer/OAuth 2.1 authentication, RFC 9728 metadata, pluggable distributed `RateLimiter` interface, body/MIME validation, redacted logs, and `read`/`write` permission policies.
- **SQLite Storage & Corruption Resilience (`@daymark/storage-sqlite`)**: `better-sqlite3` + Drizzle ORM schema, forward-only migrations (`0000_initial`, `0001_due_date_and_indexes`), WAL mode, transactional unique index for single-active focus sessions, `checkSqliteDriver()` native binding diagnostics, and automatic `DATABASE_CORRUPT` mapping with safe `checkSqliteIntegrity()` checks.
- **CLI (`@daymark/cli`)**: Commander CLI (`daymark`) covering `init`, `status`, `doctor`, `project`, `task`, `plan`, `focus`, `worklog`, `review`, `export`, and `import` with human-readable and `--json` outputs, including native driver and database integrity reporting.
- **MCP Server (`@daymark/mcp-server`)**: Official MCP TypeScript SDK v2 (`@modelcontextprotocol/server@2.4.0`) stdio server (`daymark-mcp`) exposing all 16 `daymark_*` contract tools with strict Zod validation and safe `isError` responses.
- **Packaging & Release Readiness**: Public `@daymark/*` package metadata across 9 publishable packages, local wrapper installer (`scripts/install-local.sh`), release tarball verification (`scripts/verify-release-readiness.mjs`), and automated doc drift verification (`scripts/verify-docs-sync.mjs`).
- **Platform Matrix & Verification Evidence**: Canonical config generators and honest matrix verifier (`scripts/verify-host-platforms.mjs`) distinguishing `verified` (Antigravity, OpenCode) from `smoke-tested` (Claude Code, OpenAI Codex, Cursor).
- **Deployment & Disaster Recovery Docs**: Added Cloudflare Tunnel configuration templates (`deploy/cloudflare/`), [`docs/CLAUDE_WEB_INTEGRATION.md`](./docs/CLAUDE_WEB_INTEGRATION.md), [`docs/CLOUD_ARCHITECTURE.md`](./docs/CLOUD_ARCHITECTURE.md), [`docs/DISASTER_RECOVERY.md`](./docs/DISASTER_RECOVERY.md), and [`docs/RELEASE_STRATEGY.md`](./docs/RELEASE_STRATEGY.md).
- **Contracts (`@daymark/contracts`)**: Zod v4 schemas, DTOs, typed `DaymarkError` codes (`ErrorCodeSchema`), and backup archive schema.
- **Config (`@daymark/config`)**: OS-conventional data/config/backup directories, `DAYMARK_HOME` / `DAYMARK_DATABASE_PATH` overrides, `0700`/`0600` POSIX permissions, and symlink-safe path checks.
- **Portable Skills (`@daymark/skills`)**: Validator and eval checklist over `daymark-daily-planning`, `daymark-daily-wrap`, and `daymark-task-triage`.
- **CI/CD**: GitHub Actions quality matrix (Ubuntu, macOS, Windows on Node 22/24), platform tarballs, SHA-256 checksums, and release tag workflows.
