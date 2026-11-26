import { DaymarkError, type WeekStartsOn } from '@daymark/contracts';

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  nextId(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export const cryptoIdGenerator: IdGenerator = {
  nextId: () => crypto.randomUUID(),
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const match = DATE_ONLY_REGEX.exec(dateStr);
  if (!match) {
    throw new DaymarkError('VALIDATION_FAILED', `Invalid YYYY-MM-DD date: ${dateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new DaymarkError('VALIDATION_FAILED', `Non-existent calendar date: ${dateStr}`);
  }
  return { year, month, day };
}

export function assertValidTimezone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch (cause) {
    throw new DaymarkError('INVALID_TIMEZONE', `Invalid IANA timezone: ${timeZone}`, {
      nextStep: 'Provide a valid IANA timezone such as "UTC" or "Asia/Jakarta".',
      cause,
    });
  }
}

function getZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)?.value;
    return found ? Number(found) : 0;
  };
  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
}

function partsToEpochMs(parts: ZonedParts, ms: number): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    ms,
  );
}

/**
 * Converts a wall-clock date/time in an IANA timezone into UTC epoch milliseconds,
 * resolving DST boundaries accurately.
 */
export function zonedWallTimeToUtcMs(
  dateStr: string,
  timeZone: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  assertValidTimezone(timeZone);
  const { year, month, day } = parseDateParts(dateStr);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  const offset1 = partsToEpochMs(getZonedParts(utcGuess, timeZone), ms) - utcGuess;
  const candidate1 = utcGuess - offset1;

  const offset2 = partsToEpochMs(getZonedParts(candidate1, timeZone), ms) - candidate1;
  const candidate2 = utcGuess - offset2;
  return candidate2;
}

export function startOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  return zonedWallTimeToUtcMs(dateStr, timeZone, 0, 0, 0, 0);
}

export function endOfLocalDayUtcMs(dateStr: string, timeZone: string): number {
  return zonedWallTimeToUtcMs(dateStr, timeZone, 23, 59, 59, 999);
}

export function formatUtcMsInTimezoneDate(epochMs: number, timeZone: string): string {
  assertValidTimezone(timeZone);
  const p = getZonedParts(epochMs, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addCalendarDays(dateStr: string, deltaDays: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const dt = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function getCalendarWeekDates(
  anchorDate: string,
  weekStartsOn: WeekStartsOn,
): { weekStartDate: string; weekEndDate: string; dates: string[] } {
  const { year, month, day } = parseDateParts(anchorDate);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  const startDow = weekStartsOn === 'monday' ? 1 : 0;
  const diff = (dow - startDow + 7) % 7;
  const weekStartDate = addCalendarDays(anchorDate, -diff);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addCalendarDays(weekStartDate, i));
  }
  const weekEndDate = dates[6] ?? weekStartDate;
  return { weekStartDate, weekEndDate, dates };
}

export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function parseDueInput(
  raw: string,
  timeZone: string,
): { dueAtMs: number | null; dueDate: string | null } {
  if (DATE_ONLY_REGEX.test(raw)) {
    parseDateParts(raw);
    return { dueAtMs: null, dueDate: raw };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      `Invalid due date/time "${raw}". Use YYYY-MM-DD or ISO-8601 datetime with timezone.`,
    );
  }
  assertValidTimezone(timeZone);
  return { dueAtMs: parsed, dueDate: null };
}

export function parseRangeBoundary(
  raw: string,
  timeZone: string,
  boundary: 'start' | 'end',
): number {
  if (DATE_ONLY_REGEX.test(raw)) {
    return boundary === 'start'
      ? startOfLocalDayUtcMs(raw, timeZone)
      : endOfLocalDayUtcMs(raw, timeZone);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new DaymarkError(
      'INVALID_TIME_RANGE',
      `Invalid timestamp "${raw}". Use YYYY-MM-DD or ISO-8601 datetime with timezone.`,
    );
  }
  return parsed;
}

export function parseInstantInput(raw: string): number {
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new DaymarkError('VALIDATION_FAILED', `Invalid ISO-8601 timestamp "${raw}".`);
  }
  return parsed;
}

export function resolveEffectiveDueAtMs(
  task: { dueAtMs: number | null; dueDate: string | null },
  timeZone: string,
): number | null {
  if (task.dueAtMs !== null) {
    return task.dueAtMs;
  }
  if (task.dueDate !== null) {
    return endOfLocalDayUtcMs(task.dueDate, timeZone);
  }
  return null;
}
