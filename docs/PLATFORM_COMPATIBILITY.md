# Agent Platform Compatibility and Packaging

**Important:** Each platform evolves independently. The build must re-check official documentation at implementation time and record the verification date, application version, install command, and tested capabilities. Do not treat this table as a forever-stable promise.

## 1. Shared capability strategy

The common denominator is:

1. A local MCP server exposing the Daymark tools.
2. Portable Agent Skills using `SKILL.md` and vendor-neutral workflow instructions.
3. A generated, platform-specific configuration/package to install those assets.

Native hooks and platform-specific commands are enhancements, not core requirements. Keep their behavior minimal and opt-in.

## 2. Platform notes

### Claude Code

- Native plugin layout uses `.claude-plugin/plugin.json`.
- Plugins may package `skills/`, `agents/`, `hooks/`, and `.mcp.json`.
- Plugin skills are namespaced when invoked.
- Use current plugin docs and test loading with `--plugin-dir` or the supported marketplace flow.
- Package generator target: `dist/platforms/claude-code/`.
- Do not register high-frequency hooks in MVP. If adding hooks later, keep them opt-in and non-blocking.

Official reference: https://code.claude.com/docs/en/plugins/overview

### OpenAI Codex

- Current plugin packaging uses `.codex-plugin/plugin.json` and can declare `skills` and `mcpServers`; `.mcp.json` is a documented packaging pattern in current developer docs.
- Codex also supports standalone Skills. Prefer official plugin packaging for a one-step bundle when available in the target Codex surface.
- Hosted and local execution have different filesystem/network/credential boundaries. Do not assume a local stdio MCP executable exists inside a hosted environment.
- Package generator target: `dist/platforms/codex/`.

Official references:
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/build/skills

### Cursor

- Cursor supports the open Agent Plugins format with a root `plugin.json` for Skills and MCP.
- Cursor's richer native format uses `.cursor-plugin/plugin.json` and can add rules, agents, commands, hooks, and variables.
- The docs note differences in plugin path-variable expansion; do not assume `${PLUGIN_ROOT}` or `${PLUGIN_DATA}` behavior is portable.
- Package generator targets: `dist/platforms/cursor-agent-plugin/` and, only when needed, `dist/platforms/cursor-native/`.

Official reference: https://cursor.com/docs/plugins

### Google Antigravity

- Antigravity plugins use `plugin.json` at the plugin root or `.antigravity-plugin/plugin.json`.
- Supported components include Skills, MCP config (`mcp_config.json`), agents, rules, and lifecycle hooks (`hooks.json`).
- The docs provide `agy plugin validate` for local validation.
- For a multi-provider repo, prefer `.antigravity-plugin/plugin.json` when appropriate to avoid competing root manifests.
- Package generator target: `dist/platforms/antigravity/`.

Official reference: https://antigravity.google/docs/build-plugins

### OpenCode

- OpenCode can connect to local/remote MCP servers through its `mcp` configuration.
- Skills are discovered from `.opencode/skills/<skill-id>/SKILL.md`; current docs also describe shared `.agents/skills` discovery/precedence.
- Native OpenCode plugin API is a separate enhancement. MVP must work through MCP + Skills/config without requiring a native plugin.
- Package generator target: `dist/platforms/opencode/`.

Official references:
- https://opencode.ai/docs/mcp-servers
- https://opencode.ai/docs/skills

## 3. Compatibility tiers

Report each platform independently:

- **Tier 1 — MCP + Skills:** MCP transport connects, all required tools list/call correctly, portable Skills are discoverable.
- **Tier 2 — Native package:** package manifest validates and installation flow works.
- **Tier 3 — Native lifecycle:** opt-in hooks/commands work and do not create duplicate or noisy records.

MVP acceptance requires Tier 1 for all five platforms. Tier 2 is the next milestone. Tier 3 is optional and must not block the core product.

## 4. Configuration design

Use one canonical internal configuration model, then generate platform-specific files. Do not maintain five independent copies of MCP tool definitions.

Canonical config fields:

```json
{
  "server": {
    "command": "node",
    "args": ["/absolute/path/to/daymark-mcp/dist/index.js"],
    "env": {
      "DAYMARK_HOME": "${DAYMARK_HOME}"
    }
  },
  "skills": ["daily-planning", "daily-wrap", "task-triage"]
}
```

This is an internal example, not a literal config accepted by every agent. Each generator must serialize it into the current documented format for its target.

## 5. Platform testing matrix

For each platform, verify:

- Generated files conform to current manifest schema.
- MCP server starts using configured executable/args/env.
- `daymark_get_status` succeeds.
- One write tool and one read tool succeed against the same test DB.
- Skills are discovered and contain no platform-only syntax in shared content.
- Uninstall/disable does not delete the user's database.
- Errors are actionable when the executable is missing or the DB is not initialized.

Do not claim a platform is fully verified without running this matrix in the actual application or clearly stating what was unavailable.

## 6. Dated documentation verification log

### 2026-11-26 — Official docs & local CLI inspection (Phase 0)

- **Claude Code:** Confirmed `.claude-plugin/plugin.json` manifest (required `name`, optional `version`, `description`, `author`), root `.mcp.json` (`mcpServers` with `${CLAUDE_PLUGIN_ROOT}` variable substitution), `skills/<name>/SKILL.md` discovery, and local testing via `claude --plugin-dir <dir>`. CLI binary `claude` not installed in current build host. Sources: https://code.claude.com/docs/en/plugins/overview, https://code.claude.com/docs/en/plugins-reference
- **OpenAI Codex:** Confirmed dual support for portable root `plugin.json` (Agent Plugins schema) and `.codex-plugin/plugin.json` (`name`, `version`, `description`, `skills`, `mcpServers` pointing to `.mcp.json`), as well as standalone `~/.codex/config.toml` (`[mcp_servers.<name>]` with `command`, `args`, `env`). CLI binary `codex` not installed in current build host. Sources: https://developers.openai.com/plugins/build/plugins, https://developers.openai.com/plugins/build/skills
- **Cursor:** Confirmed open Agent Plugins root `plugin.json` + `mcp.json` (`mcpServers`) and native `.cursor-plugin/plugin.json` + `skills/` + `mcp.json`. CLI/app `cursor` not installed in current build host. Source: https://cursor.com/docs/plugins
- **Google Antigravity:** Confirmed `plugin.json` or `.antigravity-plugin/plugin.json` (`$schema`, `name`, `displayName`, `version`, `description`, `suggestedPrompts`), `mcp_config.json` (`mcpServers` with `command`, `args`, `env`, `${PLUGIN_ROOT}`), `skills/` directory, and local validator `agy plugin validate [target] [--strict] [--json]`. Local `agy` CLI `1.5.17` is installed on host. Source: https://antigravity.google/docs/build-plugins
- **OpenCode:** Confirmed `opencode.json` (`$schema: "https://opencode.ai/config.json"`, `mcp.<name>` with `"type": "local"`, `"command": [...]`, `"environment": {...}`, `"enabled": true`) and `.opencode/skills/<skill-id>/SKILL.md` (plus `.agents/skills/`). Local `opencode` CLI `v2.2.5` is installed on host (`opencode mcp list|add`). Sources: https://opencode.ai/docs/mcp-servers, https://opencode.ai/docs/skills

## 7. MVP Compatibility Matrix (2026-11-26)

| Platform | Status | Tier 1 (MCP + Skills) | Tier 2 (Native Package) | Evidence & Host App Availability |
|---|---|---|---|---|
| **Claude Code** | `smoke-tested` | Generated `.mcp.json` parsed & MCP stdio `daymark_get_status` + `daymark_capture_task` passed against shared DB (`2026-11-26`). | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/` generated and verified by schema/safety checks. | `claude` CLI unavailable on build host. Manual verify: `claude --plugin-dir ./dist/platforms/claude-code`. |
| **OpenAI Codex** | `smoke-tested` | Generated `.mcp.json` parsed & MCP stdio `daymark_get_task` + `daymark_log_work` passed against shared DB (`2026-11-26`). | `.codex-plugin/plugin.json`, `.mcp.json`, `config.toml.snippet`, `skills/` generated and verified by schema/safety checks. | `codex` CLI unavailable on build host. Manual verify: add `config.toml.snippet` to `~/.codex/config.toml` and copy `skills/` to `~/.codex/skills/`. |
| **Cursor** | `smoke-tested` | Generated `mcp.json` parsed & MCP stdio `daymark_list_tasks` + `daymark_update_task` passed against shared DB (`2026-11-26`). | Both `cursor-agent-plugin/` (`plugin.json`) and `cursor-native/` (`.cursor-plugin/plugin.json`) generated & verified. | `cursor` IDE/CLI unavailable on build host. Manual verify: open plugin directory in Cursor or copy `mcp.json` to `.cursor/mcp.json`. |
| **Google Antigravity** | `verified` | Installed plugin (`agy plugin install`) and ran live `agy 1.5.17` prompt calling `daymark_get_status`, `daymark_create_project`, and `daymark_capture_task` against isolated test DB (`2026-11-26`). | `.antigravity-plugin/plugin.json`, `mcp_config.json`, `skills/` validated via `agy plugin validate --strict --json` (`0` errors, `0` warnings in `--local` mode). | Verified end-to-end in `agy 1.5.17` CLI (`2026-11-26`). Task handed off to OpenCode via shared DB. |
| **OpenCode** | `verified` | Configured `opencode.json` + `.opencode/skills/` and ran live `opencode v2.2.5` session (`opencode --standalone run`) calling `daymark_list_tasks`, `daymark_update_task`, `daymark_log_work`, and `daymark_get_today_plan` on the task created in Antigravity (`2026-11-26`). | `opencode.json` (`mcp.servers.daymark`) + `.opencode/skills/` validated via `opencode debug config` (`opencode v2.2.5`). | Verified end-to-end in `opencode v2.2.5` (`2026-11-26`) sharing the same SQLite DB with Antigravity and CLI. |
| **Standalone Web Dashboard** | `verified` | React 19 + TypeScript SPA (`apps/web`) backed by `127.0.0.1` Node HTTP API (`/api/*`) calling `@daymark/core`. | Built client (`vite`) + server (`tsdown`) and verified origin validation, CSRF protection, all 7 dashboard workflows, and live tri-surface DB sharing (`2026-11-26`). | Verified via automated integration suite (`apps/web/src/server/web-server.integration.test.ts`) and live local HTTP smoke test. |
| **Claude Web (Remote MCP)** | `smoke-tested` | Streamable HTTP `/mcp` (`daymark-mcp --http`) verified locally with official `StreamableHTTPClientTransport`, Bearer/OAuth auth, rate limits, `read`/`write` permission policy, and path redaction (`2026-11-26`). | Cloudflare Tunnel configs provided (`deploy/cloudflare/config.yml.example`); connector setup documented in [`docs/CLAUDE_WEB_INTEGRATION.md`](./CLAUDE_WEB_INTEGRATION.md). | Automated Streamable HTTP integration tests pass locally; live `claude.ai` cloud connector UI registration requires an external Anthropic account + live HTTPS tunnel outside this host. |

See [`docs/PLATFORM_VERIFICATION_EVIDENCE.md`](./PLATFORM_VERIFICATION_EVIDENCE.md) for host binary detection results (`pnpm verify:matrix`) and remaining live validation prerequisites.


