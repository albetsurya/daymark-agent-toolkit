# Testing, CI, and Release Strategy

## 1. Test layers

### Unit tests

- Task status transition rules.
- Priority and due-date ordering.
- Daily planner budget fit and missing-estimate behavior.
- Daily/weekly review grouping and totals.
- Timezone/week-boundary calculations.
- Duration calculation and active-focus conflict handling.
- Import validation and idempotency behavior.

### Storage integration tests

- Fresh database initialization.
- Migrations from previous schema versions.
- CRUD and foreign-key behavior.
- Transaction rollback for failed completion/worklog operations.
- Concurrent attempts to start focus (only one succeeds).
- Export/import round trip.

### CLI end-to-end tests

- Init profile.
- Add project/task.
- Plan day.
- Start/finish focus.
- Add worklog.
- Generate review.
- Export and import into a second temporary profile.

### MCP tests

- MCP handshake and tool listing.
- Valid call for each tool.
- Invalid arguments and bounded error results.
- Cross-surface consistency: write via MCP, read via CLI; reverse direction as well.
- stdout contains protocol frames only.
- Server exits cleanly on stdin close.

### Platform package tests

- JSON/schema validation for each plugin package.
- Relative paths remain within package root.
- No secrets or local database files are included.
- MCP command points to a built artifact and documents prerequisites.
- Skill frontmatter is valid and IDs are unique.
- Real-app smoke test where the platform is installed.

## 2. Quality commands

Provide consistent scripts:

- `pnpm lint`
- `pnpm format:check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration`
- `pnpm build`
- `pnpm pack:platforms`
- `pnpm verify:packages`

## 3. CI matrix

Minimum: Linux + current Node LTS. Expand to macOS and Windows before claiming cross-platform desktop support, especially if a native SQLite driver is selected.

CI should run install with frozen lockfile, lint, formatting check, typecheck, unit tests, integration tests, build, and package validation.

## 4. Release gates

- All tests pass.
- Migrations tested against clean and previous DB fixtures.
- Changelog updated.
- Platform compatibility table updated with test date and versions.
- Docs contain install/uninstall and backup instructions.
- No credentials or user data in package contents.
- License and package metadata are reviewed by project owner.
- Known issues are listed; no unsupported platform is described as verified.
