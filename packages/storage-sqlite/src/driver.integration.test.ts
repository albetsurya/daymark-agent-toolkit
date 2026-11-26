import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteConnection } from './index.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('@daymark/storage-sqlite driver spike', () => {
  it('supports WAL mode, foreign keys, Drizzle ORM, and partial unique indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymark-p0-sqlite-'));
    tempDirs.push(dir);
    const conn = openSqliteConnection(join(dir, 'spike.sqlite'));

    try {
      const fk = conn.raw.pragma('foreign_keys', { simple: true });
      const jm = conn.raw.pragma('journal_mode', { simple: true });
      expect(fk).toBe(1);
      expect(jm).toBe('wal');

      conn.raw.exec(`
        CREATE TABLE focus_probe (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('active', 'completed'))
        );
        CREATE UNIQUE INDEX idx_single_active ON focus_probe(status) WHERE status = 'active';
      `);

      const focusProbe = sqliteTable('focus_probe', {
        id: text('id').primaryKey(),
        status: text('status').notNull(),
      });

      conn.db.insert(focusProbe).values({ id: 'f1', status: 'active' }).run();
      expect(conn.db.select().from(focusProbe).all()).toHaveLength(1);

      expect(() => {
        conn.db.insert(focusProbe).values({ id: 'f2', status: 'active' }).run();
      }).toThrow();
    } finally {
      conn.close();
    }
  });
});
