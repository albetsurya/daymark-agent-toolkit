import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeUserFilePath,
  readProfileConfig,
  resolveDaymarkPaths,
  writeProfileConfig,
} from './index.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('@daymark/config', () => {
  it('resolves OS-specific paths and env overrides', () => {
    const linux = resolveDaymarkPaths({
      platform: 'linux',
      homeDir: '/home/dev',
      env: { XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/cfg' },
    });
    expect(linux.dataDir).toBe('/data/daymark');
    expect(linux.configPath).toBe('/cfg/daymark/config.json');
    expect(linux.databasePath).toBe('/data/daymark/daymark.sqlite');

    const mac = resolveDaymarkPaths({
      platform: 'darwin',
      homeDir: '/Users/dev',
      env: {},
    });
    expect(mac.dataDir).toBe('/Users/dev/Library/Application Support/Daymark');
    expect(mac.databasePath).toBe('/Users/dev/Library/Application Support/Daymark/daymark.sqlite');

    const win = resolveDaymarkPaths({
      platform: 'win32',
      homeDir: 'C:\\Users\\dev',
      env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    });
    expect(win.dataDir).toBe('C:\\Users\\dev\\AppData\\Local\\Daymark');
    expect(win.databasePath).toBe('C:\\Users\\dev\\AppData\\Local\\Daymark\\daymark.sqlite');

    const overridden = resolveDaymarkPaths({
      platform: 'linux',
      homeDir: '/home/dev',
      env: {
        DAYMARK_HOME: '/tmp/custom-daymark',
        DAYMARK_DATABASE_PATH: '/tmp/custom.sqlite',
      },
    });
    expect(overridden.dataDir).toBe('/tmp/custom-daymark');
    expect(overridden.databasePath).toBe('/tmp/custom.sqlite');
    expect(overridden.overriddenByEnv).toBe(true);
  });

  it('writes and reads config.json and blocks symlink user file paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daymark-cfg-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'config.json');

    writeProfileConfig(configPath, {
      version: 1,
      databasePath: join(dir, 'daymark.sqlite'),
      timezone: 'Asia/Jakarta',
      weekStartsOn: 'monday',
      dayStartTime: '09:00',
      defaultPlanMinutes: 240,
    });

    const loaded = readProfileConfig(configPath);
    expect(loaded?.timezone).toBe('Asia/Jakarta');
    expect(loaded?.defaultPlanMinutes).toBe(240);

    const realFile = join(dir, 'real.json');
    const linkFile = join(dir, 'link.json');
    writeFileSync(realFile, '{}', 'utf8');
    symlinkSync(realFile, linkFile);

    expect(() => assertSafeUserFilePath(linkFile, { mustExist: true })).toThrow(/symbolic link/i);
  });
});
