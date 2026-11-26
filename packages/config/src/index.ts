import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix as posixPath, resolve, win32 as win32Path } from 'node:path';
import {
  DaymarkError,
  TimeOfDaySchema,
  type WeekStartsOn,
  WeekStartsOnSchema,
} from '@daymark/contracts';
import * as z from 'zod';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MiB safety cap

export const ProfileConfigFileSchema = z.object({
  version: z.literal(1),
  databasePath: z.string().min(1),
  timezone: z.string().min(1),
  weekStartsOn: WeekStartsOnSchema,
  dayStartTime: TimeOfDaySchema,
  defaultPlanMinutes: z.number().int().gt(0).lte(1_440).nullable().optional(),
});

export type ProfileConfigFile = z.infer<typeof ProfileConfigFileSchema>;

export interface DaymarkPaths {
  dataDir: string;
  configDir: string;
  configPath: string;
  databasePath: string;
  backupsDir: string;
  overriddenByEnv: boolean;
}

type PathApi = typeof posixPath | typeof win32Path;

function validateEnvPath(
  rawValue: string | undefined,
  varName: string,
  pathImpl: PathApi,
): string | undefined {
  if (rawValue === undefined) return undefined;
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) {
    throw new DaymarkError('VALIDATION_FAILED', `Invalid path in ${varName}.`, {
      nextStep: `Provide a valid directory or file path for ${varName}.`,
    });
  }
  return pathImpl.resolve(trimmed);
}

/**
 * Resolves OS-conventional paths for Daymark data, config, SQLite DB, and backups,
 * honoring DAYMARK_HOME and DAYMARK_DATABASE_PATH environment overrides.
 */
export function resolveDaymarkPaths(options?: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): DaymarkPaths {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const pathImpl: PathApi = platform === 'win32' ? win32Path : posixPath;
  const home = options?.homeDir ?? homedir();

  const homeOverride = validateEnvPath(env.DAYMARK_HOME, 'DAYMARK_HOME', pathImpl);
  const dbOverride = validateEnvPath(env.DAYMARK_DATABASE_PATH, 'DAYMARK_DATABASE_PATH', pathImpl);

  let dataDir: string;
  let configDir: string;

  if (homeOverride) {
    dataDir = homeOverride;
    configDir = homeOverride;
  } else if (platform === 'darwin') {
    const appSupport = pathImpl.join(home, 'Library', 'Application Support', 'Daymark');
    dataDir = appSupport;
    configDir = appSupport;
  } else if (platform === 'win32') {
    const localAppData =
      validateEnvPath(env.LOCALAPPDATA, 'LOCALAPPDATA', pathImpl) ??
      pathImpl.join(home, 'AppData', 'Local');
    const winDir = pathImpl.join(localAppData, 'Daymark');
    dataDir = winDir;
    configDir = winDir;
  } else {
    const xdgData =
      validateEnvPath(env.XDG_DATA_HOME, 'XDG_DATA_HOME', pathImpl) ??
      pathImpl.join(home, '.local', 'share');
    const xdgConfig =
      validateEnvPath(env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME', pathImpl) ??
      pathImpl.join(home, '.config');
    dataDir = pathImpl.join(xdgData, 'daymark');
    configDir = pathImpl.join(xdgConfig, 'daymark');
  }

  const databasePath = dbOverride ?? pathImpl.join(dataDir, 'daymark.sqlite');
  const configPath = pathImpl.join(configDir, 'config.json');
  const backupsDir = pathImpl.join(dataDir, 'backups');

  return {
    dataDir,
    configDir,
    configPath,
    databasePath,
    backupsDir,
    overriddenByEnv: Boolean(homeOverride || dbOverride),
  };
}

/**
 * Ensures a directory exists with owner-only permissions (0700 on POSIX).
 */
export function ensureSecureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(dirPath, 0o700);
    } catch {
      // Best-effort when filesystem does not support POSIX permissions.
    }
  }
}

/**
 * Applies restrictive owner-only file permissions (0600 on POSIX).
 */
export function enforceOwnerOnlyFileMode(filePath: string): void {
  if (process.platform !== 'win32' && existsSync(filePath)) {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort when filesystem does not support POSIX permissions.
    }
  }
}

/**
 * Validates user-supplied file paths for export/import to prevent NUL bytes,
 * symlink following on the target path, and oversized import reads.
 */
export function assertSafeUserFilePath(
  rawPath: string,
  options: { mustExist?: boolean; maxBytes?: number } = {},
): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) {
    throw new DaymarkError('VALIDATION_FAILED', 'File path must be a non-empty valid path.');
  }
  const resolved = resolve(trimmed);
  const maxBytes = options.maxBytes ?? MAX_IMPORT_BYTES;

  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new DaymarkError(
        'VALIDATION_FAILED',
        'Refusing to read or write through a symbolic link.',
        { nextStep: 'Specify a regular file path instead of a symlink.' },
      );
    }
    if (stat.isDirectory()) {
      throw new DaymarkError('VALIDATION_FAILED', 'Expected a file path, got a directory.');
    }
    if (options.mustExist && stat.size > maxBytes) {
      throw new DaymarkError(
        'VALIDATION_FAILED',
        `File exceeds maximum allowed size (${maxBytes} bytes).`,
      );
    }
  } else if (options.mustExist) {
    throw new DaymarkError('VALIDATION_FAILED', 'Specified file does not exist.', {
      nextStep: 'Check the file path and try again.',
    });
  } else {
    const parent = dirname(resolved);
    if (existsSync(parent)) {
      const parentStat = lstatSync(parent);
      if (parentStat.isSymbolicLink()) {
        throw new DaymarkError(
          'VALIDATION_FAILED',
          'Refusing to write inside a symlinked target directory.',
        );
      }
    }
  }

  return resolved;
}

export function readProfileConfig(configPath: string): ProfileConfigFile | null {
  if (!existsSync(configPath)) {
    return null;
  }
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink()) {
    throw new DaymarkError('VALIDATION_FAILED', 'Config file cannot be a symbolic link.');
  }
  const raw = readFileSync(configPath, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    throw new DaymarkError('VALIDATION_FAILED', 'Profile config.json is not valid JSON.', {
      cause,
    });
  }
  const result = ProfileConfigFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new DaymarkError('VALIDATION_FAILED', 'Profile config.json failed schema validation.', {
      details: { issues: result.error.issues.map((i) => i.message) },
    });
  }
  return result.data;
}

export function writeProfileConfig(configPath: string, config: ProfileConfigFile): void {
  const validated = ProfileConfigFileSchema.parse(config);
  ensureSecureDir(dirname(configPath));
  writeFileSync(configPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  enforceOwnerOnlyFileMode(configPath);
}

export function detectSystemTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && tz.length > 0 ? tz : 'UTC';
}

export function defaultWeekStartsOn(): WeekStartsOn {
  return 'monday';
}
