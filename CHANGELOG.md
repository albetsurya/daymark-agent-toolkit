# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Shared Core Layering (`@daymark/core`, `ADR-013`)**: Separated `domain/`, `storage/` (`DaymarkStore` + cloud-ready `AsyncDaymarkStore` + `TenantContext`), and `application/` (`ExecutionContext`, `PermissionPolicy`, `createGuardedDaymarkService`) with zero filesystem path or Node `Buffer` dependencies in core.
- **Standalone Web Dashboard (`@daymark/web`, `apps/web`)**: React 19 + TypeScript SPA backed by a loopback-only (`127.0.0.1`) Node HTTP API (`daymark-web`) with `Host`/`Origin` validation, HMAC CSRF protection, and Overview, Projects, Tasks, Daily Plan, Focus Session, Worklog, and Weekly Review views.
- **Remote Streamable HTTP MCP (`@daymark/mcp-server`)**: Added `/mcp` Streamable HTTP adapter (`daymark-mcp --http`) using `@modelcontextprotocol/server` `createMcpHandler`, Bearer/OAuth 2.1 authentication, RFC 9728 metadata, sliding-window rate limiting, body/MIME validation, redacted logs, and `read`/`write` permission policies.
- **Deployment & Architecture Docs**: Added Cloudflare Tunnel configuration templates (`deploy/cloudflare/`), [`docs/CLAUDE_WEB_INTEGRATION.md`](./docs/CLAUDE_WEB_INTEGRATION.md), and [`docs/CLOUD_ARCHITECTURE.md`](./docs/CLOUD_ARCHITECTURE.md).

## [0.1.0] - 2026-11-26

### Added
- **Contracts (`@daymark/contracts`)**: Zod v4 schemas, DTOs, typed `DaymarkError` codes, and backup archive schema.
- **Config (`@daymark/config`)**: OS-conventional data/config/backup directories, `DAYMARK_HOME` / `DAYMARK_DATABASE_PATH` overrides, `0700`/`0600` POSIX permissions, and symlink-safe path checks.
- **Core (`@daymark/core`)**: Pure deterministic daily planner, daily/weekly reviews, task transition validation, DST-aware IANA timezone math, idempotency, and backup export/validate/import use cases.
- **SQLite Storage (`@daymark/storage-sqlite`)**: `better-sqlite3` + Drizzle ORM schema, forward-only migrations (`0000_initial`, `0001_due_date_and_indexes`), WAL mode, and transactional partial unique index for single-active focus sessions.
- **CLI (`@daymark/cli`)**: Commander CLI (`daymark`) covering `init`, `status`, `doctor`, `project`, `task`, `plan`, `focus`, `worklog`, `review`, `export`, and `import` with human-readable and `--json` outputs.
- **MCP Server (`@daymark/mcp-server`)**: Official MCP TypeScript SDK v2 (`@modelcontextprotocol/server@2.4.0`) stdio server (`daymark-mcp`) exposing all 16 `daymark_*` contract tools with strict Zod validation and safe `isError` responses.
- **Portable Skills (`@daymark/skills`)**: Validator and eval checklist over `daymark-daily-planning`, `daymark-daily-wrap`, and `daymark-task-triage`.
- **Platform Adapters (`@daymark/platform-adapters`)**: Canonical config generator and package verifier for Claude Code, OpenAI Codex, Cursor, Google Antigravity, and OpenCode.
- **CI/CD**: GitHub Actions quality matrix (Ubuntu, macOS, Windows on Node 22/24) and release tarball + SHA-256 checksum workflow.
- **Naming, License & Docs**: Updated product naming to Daymark (`ADR-012`), adopted `Apache-2.0` (`LICENSE`, workspace manifests, `ADR-011`), and added CLI/MCP terminal screenshots in `README.md`.
