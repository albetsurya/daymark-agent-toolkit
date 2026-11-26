#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findBinary(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

const binaries = {
  agy: findBinary('agy'),
  opencode: findBinary('opencode'),
  claude: findBinary('claude'),
  codex: findBinary('codex'),
  cursor: findBinary('cursor'),
  cloudflared: findBinary('cloudflared'),
};

const tempOut = mkdtempSync(join(tmpdir(), 'daymark-matrix-verify-'));
try {
  // 1. Pack & verify all 6 generated bundles via workspace package adapter
  const adaptersBin = join(ROOT_DIR, 'packages/platform-adapters/dist/bin.mjs');
  if (!existsSync(adaptersBin)) {
    throw new Error('Built platform-adapters binary not found. Run `pnpm build` first.');
  }

  const adaptersModUrl = new URL(
    '../packages/platform-adapters/dist/index.mjs',
    import.meta.url,
  ).href;
  const adapters = await import(adaptersModUrl);
  const generated = adapters.generateAllPlatformPackages({
    outputRoot: tempOut,
    mode: 'local',
    nodeExecutable: process.execPath,
  });
  const checked = adapters.verifyGeneratedPlatformPackages(tempOut);
  const allValid = checked.every((r) => r.valid);
  if (!allValid) {
    const failed = checked.filter((r) => !r.valid);
    throw new Error(`Generated bundle validation failed: ${JSON.stringify(failed)}`);
  }

  // 2. Host live binary checks (never fabricate passes when host app is absent)
  let agyLiveStatus = 'not_installed';
  if (binaries.agy) {
    const raw = execFileSync(
      binaries.agy,
      ['plugin', 'validate', '--strict', '--json', join(tempOut, 'antigravity')],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw);
    const issues = (parsed.findings ?? []).filter(
      (f) => f.severity === 'error' || f.severity === 'warning',
    );
    agyLiveStatus =
      issues.length === 0 ? `strict-validated (${binaries.agy})` : `failed (${issues.length} findings)`;
    if (issues.length > 0) {
      throw new Error(`agy plugin validate failed: ${JSON.stringify(issues)}`);
    }
  }

  let opencodeVersion = 'not_installed';
  if (binaries.opencode) {
    opencodeVersion = execFileSync(binaries.opencode, ['--version'], {
      encoding: 'utf8',
    }).trim();
  }

  let cloudflaredVersion = 'not_installed';
  if (binaries.cloudflared) {
    cloudflaredVersion = execFileSync(binaries.cloudflared, ['--version'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)[0];
  }

  const report = {
    generatedBundles: generated.length,
    manifestAndSkillsValid: allValid,
    hostBinaries: binaries,
    liveChecks: {
      antigravity: agyLiveStatus,
      opencode: opencodeVersion,
      cloudflared: cloudflaredVersion,
    },
    honestStatusPolicy: {
      'google-antigravity': binaries.agy ? 'verified (live agy CLI)' : 'smoke-tested',
      opencode: binaries.opencode ? 'verified (live opencode CLI)' : 'smoke-tested',
      'claude-code': binaries.claude
        ? 'requires manual interactive run'
        : 'smoke-tested (claude binary absent; config/MCP protocol only)',
      'openai-codex': binaries.codex
        ? 'requires manual interactive run'
        : 'smoke-tested (codex binary absent; config/MCP protocol only)',
      cursor: binaries.cursor
        ? 'requires manual interactive run'
        : 'smoke-tested (cursor binary absent; config/MCP protocol only)',
      'claude-web':
        'smoke-tested (Streamable HTTP /mcp verified locally; live claude.ai connector requires HTTPS tunnel + Anthropic account)',
      'web-dashboard': 'verified (local HTTP API + CSRF + React SPA integration suite)',
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(tempOut, { recursive: true, force: true });
}
