import { describe, expect, it } from 'vitest';
import { DaymarkError, SystemStatusSchema } from './index.js';

describe('@daymark/contracts baseline', () => {
  it('validates system status schema and DaymarkError shape', () => {
    const status = SystemStatusSchema.parse({
      initialized: false,
      appVersion: '0.1.0',
      schemaVersion: null,
      timezone: null,
      activeFocusSession: null,
      dataDir: null,
      dataDirConfigured: true,
      databaseReady: false,
    });
    expect(status.initialized).toBe(false);

    const err = new DaymarkError('PROFILE_NOT_INITIALIZED', 'Run daymark init first.', {
      nextStep: 'Run `daymark init` to create the local database.',
    });
    expect(err.code).toBe('PROFILE_NOT_INITIALIZED');
    expect(err.nextStep).toContain('daymark init');
  });
});
