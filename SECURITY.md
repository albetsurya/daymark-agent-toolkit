# Security and Privacy Statement

Daymark keeps personal productivity records local, inspectable, and under user control.

## Privacy Guarantees

- **No cloud accounts or remote sync:** All data resides locally in SQLite and JSON config files.
- **No telemetry:** Daymark sends no analytics, crash reports, or usage pings.
- **No passive surveillance:** Daymark never reads browser history, active window titles, keystrokes, screenshots, or editor telemetry.
- **No hidden LLM calls:** The core engine runs deterministically and contains no model-provider SDKs or API keys.

## Filesystem and Database Safety

- Local directories use `0700` and database, config, and backup files use `0600` permissions on POSIX systems.
- Export and import commands refuse to traverse or follow symlinks and cap import file size at 50 MiB.
- Destructive replace imports require both schema/reference validation and explicit confirmation (`--confirm` / `confirm: true`).
- Credentials and auth tokens must never be stored in Daymark SQLite tables or exported backups.

## MCP Server Safety

- Runs strictly over local `stdio` transport; no TCP socket is opened.
- Exposes only the 16 typed productivity tools in [docs/MCP_CONTRACT.md](./docs/MCP_CONTRACT.md). No raw SQL, filesystem path, shell execution, or HTTP proxy tools exist.
- Database paths are configured via process environment (`DAYMARK_HOME`, `DAYMARK_DATABASE_PATH`), never accepted from MCP tool arguments.
- Tool error responses sanitize stack traces and internal paths.
- Opt-in diagnostic logs (`pino`) go strictly to `stderr` and redact task titles, descriptions, notes, and worklog bodies.

## Reporting Security Issues

Enable GitHub Security Advisories when publishing the repository so vulnerability reports can be submitted privately rather than in public issues.
