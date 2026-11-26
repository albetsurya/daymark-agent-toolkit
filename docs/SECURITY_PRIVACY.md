# Security and Privacy Requirements

## 1. Defaults

- Local-first: no account, telemetry, or network connection required for core use.
- No telemetry in MVP.
- No background screen, window-title, keystroke, microphone, browser, or editor monitoring.
- No automatic uploads or remote backups.
- Integrations are absent until explicitly configured.
- Agent clients are not trusted as authorization boundaries; the local process runs with the user's permissions.

## 2. Database and filesystem

- Store data in OS-appropriate application data directories.
- Apply restrictive file permissions where supported (owner-only database/config/backups).
- Never place credentials in SQLite or exported backups.
- Backups must be user-triggered and provide a clear destination.
- Import must validate archive version, record schemas, relationships, sizes, and duplicate IDs before writing.
- Avoid path traversal and symlink-following during export/import.

## 3. MCP safety

- Expose only specific typed tools. Never expose generic shell, SQL, filesystem, HTTP proxy, or code execution tools.
- Validate every tool argument with Zod and enforce size limits.
- Keep the server on stdio in MVP. Do not bind a TCP port by default.
- Do not write logs to stdout in stdio mode.
- Do not return local absolute paths unless needed for user-directed troubleshooting.
- Cap pagination and response payload size.

## 4. Actions and confirmation

- Normal task capture/update/focus/worklog actions are allowed when directly requested by the user through the agent.
- Destructive profile reset, destructive import, permanent deletion, and external-service writes require a separate explicit confirmation step.
- Never silently replace an active focus session.
- Do not automatically mark tasks complete based only on agent claims; completion should be a user-directed action or a clearly configured explicit workflow.

## 5. Logging

- Log operation names, timing, and safe error codes.
- Do not log task titles, descriptions, worklog details, note content, auth tokens, or environment values by default.
- Diagnostic verbose mode must be explicit and warn that it may include metadata.

## 6. Local Web Dashboard & Remote MCP controls

- **Local Web Dashboard (`apps/web`):**
  - Binds strictly to loopback interfaces (`127.0.0.1` default; non-loopback binds rejected).
  - Validates `Host`, `Origin`, and `Sec-Fetch-Site` headers; enforces `HttpOnly; SameSite=Strict` cookie + HMAC `X-CSRF-Token` verification on all mutating HTTP API routes.
  - Browser code never reads SQLite directly; `/api/status` redacts `dataDir` (`null`) and destructive backup import/export routes are omitted from the web HTTP surface.
- **Remote MCP Server (`daymark-mcp --http`):**
  - Binds to `127.0.0.1` behind HTTPS reverse proxy / Cloudflare Tunnel (`deploy/cloudflare/config.yml.example`).
  - Requires Bearer token (`Authorization: Bearer <token>`) verified via timing-safe SHA-256 comparison or an `OAuthTokenVerifier`, returning `401` with `WWW-Authenticate` on missing/invalid credentials.
  - Enforces `@daymark/core` `PermissionPolicy` (`read` vs `write`, blocking `backup` and destructive operations remotely), `Host`/`Origin` allowlists, `1 MiB` payload limit, `application/json` validation, sliding-window rate limiting (`429`), redacted `pino` logs, and `dataDir: null` path redaction.
  - Never exposes raw SQLite files or `/db` / `/sqlite` / `/export` endpoints.
