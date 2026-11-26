# Claude Web Integration Guide (Remote MCP via Streamable HTTP)

This guide explains how to connect **Daymark Agent Toolkit** to **Claude Web (`claude.ai`)** using the Streamable HTTP Remote MCP server (`/mcp`) over HTTPS via Cloudflare Tunnel.

> **Important boundary:** Claude Web connects to your MCP endpoint from Anthropic's cloud infrastructure. It cannot reach `http://127.0.0.1:8787` directly; you must expose ONLY the authenticated `/mcp` endpoint over **HTTPS** (for example via Cloudflare Tunnel). Never expose the local Web Dashboard (`127.0.0.1:3456`) or raw SQLite files publicly.

---

## 1. Prerequisites

1. Build all workspace packages:
   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```
2. Initialize your Daymark profile if not already initialized:
   ```bash
   node packages/cli/dist/bin.mjs init --timezone Asia/Jakarta
   ```
3. Generate a strong bearer token (32+ random bytes):
   ```bash
   openssl rand -base64 32
   ```
4. Ensure `cloudflared` is installed (`cloudflared --version`).

---

## 2. Option A — Quick Development Tunnel (Temporary URL)

Use this only for short-lived personal testing. Note that Quick Tunnel URLs change on every restart (`*.trycloudflare.com`).

1. Start Daymark Remote MCP bound to `127.0.0.1:8787`, allowing `*.trycloudflare.com` hosts:
   ```bash
   export DAYMARK_MCP_TOKEN="YOUR_GENERATED_TOKEN"
   export DAYMARK_MCP_ALLOWED_HOSTS="*.trycloudflare.com"
   export DAYMARK_MCP_ALLOWED_ORIGINS="https://claude.ai"
   export DAYMARK_LOG_LEVEL="info"

   node packages/mcp-server/dist/bin.mjs --http --host 127.0.0.1 --port 8787
   ```
2. In a second terminal, start a Cloudflare Quick Tunnel:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```
3. Copy the HTTPS URL printed by `cloudflared` (for example `https://random-words.trycloudflare.com`) and append `/mcp`:
   ```text
   https://random-words.trycloudflare.com/mcp
   ```

---

## 3. Option B — Personal Named Tunnel (Persistent HTTPS Domain)

Recommended for ongoing personal use so you do not have to recreate the connector when restarting.

1. Copy [`deploy/cloudflare/config.yml.example`](../deploy/cloudflare/config.yml.example) to `~/.cloudflared/config.yml` and set your tunnel UUID + hostname (e.g., `daymark-mcp.yourdomain.com`).
   - Notice the ingress regex `^/(mcp|healthz|\.well-known/.*)$` ensures only the Remote MCP endpoint, safe health check, and OAuth metadata route can be reached through the tunnel.
2. Start Daymark Remote MCP with your domain allowlisted:
   ```bash
   export DAYMARK_MCP_TOKEN="YOUR_GENERATED_TOKEN"
   export DAYMARK_MCP_ALLOWED_HOSTS="daymark-mcp.yourdomain.com"
   export DAYMARK_MCP_ALLOWED_ORIGINS="https://claude.ai"
   export DAYMARK_LOG_LEVEL="info"

   node packages/mcp-server/dist/bin.mjs --http --host 127.0.0.1 --port 8787
   ```
3. Run your named tunnel:
   ```bash
   cloudflared tunnel run daymark-mcp
   ```
4. Verify HTTPS reachability from outside localhost before registering in Claude:
   ```bash
   # Safe health check (unauthenticated, returns no paths/secrets)
   curl -fsS https://daymark-mcp.yourdomain.com/healthz

   # Verify /mcp rejects missing credentials with 401
   curl -i -sS -X POST https://daymark-mcp.yourdomain.com/mcp -H "Content-Type: application/json" -d '{}'
   ```

---

## 4. Registering in Claude Web (`claude.ai`)

1. Open [claude.ai](https://claude.ai) in your browser.
2. Go to **Customize** > **Connectors** > **Add custom connector**.
3. Fill in the connector details:
   - **Name:** `Daymark`
   - **Remote MCP Server URL:** `https://daymark-mcp.yourdomain.com/mcp` (or your Quick Tunnel `/mcp` URL)
4. Expand **Advanced settings** and configure authentication:
   - **Authentication method (Personal Bearer Token):**
     Supply the Authorization request header:
     ```text
     Authorization: Bearer YOUR_GENERATED_TOKEN
     ```
   - **Read-only testing (optional):**
     If you set `DAYMARK_MCP_READONLY_TOKEN` on the server and supply that token instead, Claude can inspect projects, tasks, daily plans, worklogs, and reviews, while any write tool (`daymark_capture_task`, `daymark_start_focus`, etc.) is rejected by `@daymark/core` with `FORBIDDEN`.
5. Save the connector, then inside any Claude Web chat click the **`+` (Add)** menu and enable the **Daymark** connector.

---

## 5. Multi-User OAuth 2.1 Configuration (Future / Shared Deployments)

For multi-user deployments, `@daymark/mcp-server` accepts an `oauth` configuration in `createDaymarkHttpMcpHandler` / `startDaymarkHttpServer`:

- Exposes RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` and RFC 8414 Authorization Server metadata at `/.well-known/oauth-authorization-server`.
- Advertises `resource_metadata="..."` inside `WWW-Authenticate: Bearer` on `401` responses so Claude Web's OAuth discovery flow can locate the authorization server.
- Validates incoming OAuth access tokens via `OAuthTokenVerifier`, mapping verified `scopes` (`read` / `write`) and `tenantId` directly into `@daymark/core`'s `ExecutionContext`.

---

## 6. Request Headers & Security Guarantees

| Check | Behavior |
|---|---|
| Transport | Streamable HTTP (`POST /mcp`, optional `GET`/`DELETE /mcp`) via `@modelcontextprotocol/server@2.4.0` (`createMcpHandler`) |
| Legacy SSE | Not used as primary transport |
| Authentication | Timing-safe SHA-256 comparison for bearer tokens; `401 Unauthorized` when missing/invalid |
| Host validation | Rejects unallowlisted `Host` headers (`403 Forbidden`) |
| Origin validation | If `Origin` header is present, must match `localhost`, `127.0.0.1`, `https://claude.ai`, or `DAYMARK_MCP_ALLOWED_ORIGINS` (`403 Forbidden`) |
| Rate limiting | Sliding-window limiter per principal/IP (`429 Too Many Requests` + `Retry-After`) |
| Body limits | Rejects non-`application/json` POSTs (`415`) and payloads over `1 MiB` (`413`) |
| Path & DB safety | `daymark_get_status` returns `dataDir: null` remotely; no SQLite file, raw SQL, or `/db` route is exposed; `backup` scope is disabled remotely |
