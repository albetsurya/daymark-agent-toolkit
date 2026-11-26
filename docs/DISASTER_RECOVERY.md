# Database Upgrades, Integrity Checks, and Disaster Recovery

This guide explains how to safely upgrade the Daymark SQLite schema across versions, verify database integrity, recover from unexpected shutdowns or `DATABASE_BUSY` errors, and restore from backups if a SQLite file is damaged.

---

## 1. Pre-Upgrade Checklist

Before upgrading Daymark binaries (`daymark`, `daymark-mcp`, `daymark-web`) across schema versions:

1. **Export a verified JSON backup snapshot:**
   ```bash
   node packages/cli/dist/bin.mjs export "./backups/daymark-pre-upgrade-$(date +%F).json"
   ```
   Backups are written with owner-only `0600` permissions on POSIX systems and preserve project/task UUIDs, tags, focus sessions, worklogs, and settings (`formatVersion: 1`).
2. **Stop running background adapters** (`daymark-mcp --http`, `daymark-web`) so no open file handles conflict during upgrades.
3. **Run `daymark init` on the existing profile:**
   - Migrations in [`packages/storage-sqlite/migrations/`](../packages/storage-sqlite/migrations) are **forward-only** and applied inside a single SQLite transaction recorded in `schema_migrations`.
   - `daymark init` is strictly idempotent: existing timezone settings, projects, tasks, and worklogs are preserved.
4. **Verify health with `daymark doctor`:**
   ```bash
   node packages/cli/dist/bin.mjs doctor
   ```
   Confirm `Database integrity: ok` and the expected `Schema version`.

---

## 2. Detecting Corruption (`DATABASE_CORRUPT`)

`@daymark/storage-sqlite` exposes `checkSqliteIntegrity()` (SQLite `PRAGMA integrity_check`) and maps `SQLITE_CORRUPT` / `SQLITE_NOTADB` errors to `DaymarkError('DATABASE_CORRUPT', ...)`.

Run a safe diagnostic without mutating data:

```bash
node packages/cli/dist/bin.mjs doctor --json
```

If the SQLite file header or pages are damaged, `doctor` reports:

- `databaseIntegrity: "corrupt"`
- `integrityMessages`: exact SQLite diagnostic details
- Recovery instructions pointing to `daymark import --mode replace --confirm`

Daymark **never** silently deletes or recreates a corrupted `.sqlite` file behind your back.

---

## 3. Recovering from a Corrupted Database File

1. **Quarantine the damaged database and WAL/SHM sidecar files** (do not delete immediately until recovery succeeds):
   ```bash
   DATA_DIR="${DAYMARK_HOME:-$HOME/.local/share/daymark}"
   mv "${DATA_DIR}/daymark.sqlite" "${DATA_DIR}/daymark.sqlite.corrupt.$(date +%s)"
   mv "${DATA_DIR}/daymark.sqlite-wal" "${DATA_DIR}/daymark.sqlite-wal.corrupt" 2>/dev/null || true
   mv "${DATA_DIR}/daymark.sqlite-shm" "${DATA_DIR}/daymark.sqlite-shm.corrupt" 2>/dev/null || true
   ```
2. **Re-initialize a clean database:**
   ```bash
   node packages/cli/dist/bin.mjs init --timezone Asia/Jakarta
   ```
3. **Dry-run your backup archive before writing:**
   ```bash
   node packages/cli/dist/bin.mjs import ./daymark-backup.json --dry-run --mode replace
   ```
4. **Restore with explicit confirmation (`--confirm`):**
   ```bash
   node packages/cli/dist/bin.mjs import ./daymark-backup.json --mode replace --confirm
   ```
5. **Confirm integrity and counts:**
   ```bash
   node packages/cli/dist/bin.mjs doctor
   node packages/cli/dist/bin.mjs review week
   ```

---

## 4. Handling Process Interruptions & `DATABASE_BUSY`

- Daymark opens SQLite with `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, and `PRAGMA busy_timeout = 5000`.
- All multi-step writes (`captureTask`, `completeTask`, `startFocus`, `importBackup`) run inside atomic SQLite transactions: if a writer process receives `SIGTERM` or `SIGKILL` mid-transaction before commit, SQLite WAL crash recovery rolls back partial changes automatically on the next open.
- Both `daymark-mcp --http` and `daymark-web` install `SIGINT` and `SIGTERM` shutdown hooks to drain requests and call `store.close()`.
- If `DATABASE_BUSY` occurs transiently while multiple interfaces (`daymark`, STDIO MCP, `daymark-web`) write concurrently, retry once any runaway background process is checked (`lsof`/`ps`).
