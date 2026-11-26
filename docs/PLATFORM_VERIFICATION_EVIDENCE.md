# Platform & Connector Verification Evidence (`2026-11-26`)

Daymark strictly distinguishes **Verified** (end-to-end executed against the actual client application or live server flow) from **Smoke-tested** (generated configs validated and exercised against the MCP/HTTP protocol in automated integration tests without the vendor's proprietary desktop/CLI client present on the build host).

---

## 1. Host Environment Check

Run locally on `2026-11-26`:

```bash
pnpm verify:matrix
```

Detected binaries on this host:
- `agy`: installed (`/home/albet-surya-kembara/.local/bin/agy`)
- `opencode`: installed (`/home/albet-surya-kembara/.nvm/versions/node/v24.21.0/bin/opencode`)
- `cloudflared`: installed (`/usr/local/bin/cloudflared`)
- `claude`: **not installed**
- `codex`: **not installed**
- `cursor`: **not installed**

---

## 2. Per-Platform Evidence Matrix

| Target | Classification | Automated Coverage (CI & Local) | Live Native Host / Account Evidence | What Remains Before Upgrading Status |
|---|---|---|---|---|
| **Google Antigravity** | `verified` | `adapters.integration.test.ts` + `verify:packages` + `agy plugin validate --strict` | Installed via `agy plugin install`; ran live `agy 1.5.17` session creating project + task on shared DB (`2026-11-26`) | None |
| **OpenCode** | `verified` | `adapters.integration.test.ts` + `verify:packages` | Validated via `opencode debug config` (`v2.2.5`); ran `opencode --standalone run` updating task, logging work, and generating plan (`2026-11-26`) | None |
| **Standalone Web Dashboard** | `verified` | `apps/web/src/server/web-server.integration.test.ts` (Origin/Host checks, HMAC CSRF, API parity, tri-surface DB sync) | Rendered live SPA via `daymark-web` + headless Chromium (`05`–`07` screenshots) | None |
| **Claude Code** | `smoke-tested` | Generated `.claude-plugin/plugin.json` + `.mcp.json` parsed and run through real `StdioClientTransport` in `adapters.integration.test.ts` | **Not run live** (`claude` CLI not installed on build host) | Run `claude --plugin-dir ./dist/platforms/claude-code`, execute read+write tools, save output log |
| **OpenAI Codex** | `smoke-tested` | Generated `.codex-plugin/plugin.json` + `.mcp.json` + `config.toml.snippet` validated and run through `StdioClientTransport` in `adapters.integration.test.ts` | **Not run live** (`codex` CLI not installed on build host) | Run `codex` with `[mcp_servers.daymark]`, execute read+write tools, save output log |
| **Cursor** | `smoke-tested` | Generated `cursor-agent-plugin/` + `cursor-native/` validated and run through `StdioClientTransport` in `adapters.integration.test.ts` | **Not run live** (`cursor` desktop/CLI not installed on build host) | Enable MCP + skills in Cursor IDE/CLI, execute read+write tools, save output log |
| **Claude Web (Remote MCP)** | `smoke-tested` | `packages/mcp-server/src/http.integration.test.ts`: 16 tools on `/mcp` via `StreamableHTTPClientTransport`, Bearer + OAuth permission policy, rate limit, path redaction, body/MIME limits | **Not run live against claude.ai cloud** (requires live Anthropic account + interactive `Customize > Connectors > Add custom connector` registration over HTTPS tunnel) | Start `cloudflared tunnel` -> register URL + header in `claude.ai` -> run tool calls from web chat |

---

## 3. Re-running Automated Checks

```bash
# Run cross-platform bundle generation + strict host validator checks
pnpm verify:matrix

# Run full unit + integration matrix (Linux / macOS / Windows in CI on Node 22 & 24)
pnpm test && pnpm test:integration
```
