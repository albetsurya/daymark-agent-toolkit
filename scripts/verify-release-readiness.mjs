#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_PERSISTENT = process.argv.includes('--pack');

const PUBLISHABLE_PACKAGES = [
  {
    dir: 'packages/contracts',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/index.d.mts'],
  },
  {
    dir: 'packages/config',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/index.d.mts'],
  },
  {
    dir: 'packages/core',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/index.d.mts'],
  },
  {
    dir: 'packages/storage-sqlite',
    expectedFiles: [
      'package/dist/index.mjs',
      'package/dist/migrations/0000_initial.sql',
      'package/dist/migrations/0001_due_date_and_indexes.sql',
    ],
  },
  {
    dir: 'packages/skills',
    expectedFiles: [
      'package/dist/index.mjs',
      'package/dist/skills/daily-planning/SKILL.md',
      'package/dist/skills/daily-wrap/SKILL.md',
      'package/dist/skills/task-triage/SKILL.md',
    ],
  },
  {
    dir: 'packages/cli',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/bin.mjs'],
    expectedBins: ['daymark'],
  },
  {
    dir: 'packages/mcp-server',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/bin.mjs'],
    expectedBins: ['daymark-mcp'],
  },
  {
    dir: 'packages/platform-adapters',
    expectedFiles: ['package/dist/index.mjs', 'package/dist/bin.mjs'],
  },
  {
    dir: 'apps/web',
    expectedFiles: [
      'package/dist/server/index.mjs',
      'package/dist/server/bin.mjs',
      'package/dist/client/index.html',
    ],
    expectedBins: ['daymark-web'],
  },
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`Release readiness check failed: ${msg}`);
  }
}

const rootPkg = readJson(join(ROOT_DIR, 'package.json'));
assert(rootPkg.private === true, 'Root monorepo package.json must remain private: true');

const fixturesPkg = readJson(join(ROOT_DIR, 'packages/test-fixtures/package.json'));
assert(fixturesPkg.private === true, '@daymark/test-fixtures must remain private: true');

const destDir = PACK_PERSISTENT
  ? join(ROOT_DIR, 'dist/npm')
  : mkdtempSync(join(tmpdir(), 'daymark-npm-pack-'));

mkdirSync(destDir, { recursive: true });

try {
  const packedSummary = [];

  for (const item of PUBLISHABLE_PACKAGES) {
    const pkgDir = join(ROOT_DIR, item.dir);
    const pkgJson = readJson(join(pkgDir, 'package.json'));
    const name = pkgJson.name;

    assert(pkgJson.private !== true, `${name} must not set private: true`);
    assert(pkgJson.version === rootPkg.version, `${name} version (${pkgJson.version}) != root (${rootPkg.version})`);
    assert(pkgJson.license === 'Apache-2.0', `${name} must specify Apache-2.0 license`);
    assert(pkgJson.publishConfig?.access === 'public', `${name} must declare publishConfig.access = public`);
    assert(Array.isArray(pkgJson.files) && pkgJson.files.includes('dist'), `${name} files must include "dist"`);

    if (item.expectedBins) {
      for (const binName of item.expectedBins) {
        assert(typeof pkgJson.bin?.[binName] === 'string', `${name} missing bin.${binName}`);
      }
    }

    const tgzName = execFileSync(
      'pnpm',
      ['pack', '--pack-destination', destDir],
      { cwd: pkgDir, encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)
      .pop();

    assert(tgzName && existsSync(join(destDir, tgzName)) || (tgzName && existsSync(tgzName)), `Missing tarball output for ${name}: ${tgzName}`);
    const tgzPath = existsSync(tgzName) ? tgzName : join(destDir, tgzName);

    const packedPkgRaw = execFileSync('tar', ['-xOzf', tgzPath, 'package/package.json'], {
      encoding: 'utf8',
    });
    const packedPkg = JSON.parse(packedPkgRaw);
    for (const depMap of [packedPkg.dependencies, packedPkg.optionalDependencies, packedPkg.peerDependencies]) {
      if (!depMap) continue;
      for (const [depName, depSpec] of Object.entries(depMap)) {
        assert(
          !String(depSpec).startsWith('workspace:'),
          `Packed ${name} still has unresolved workspace specifier for ${depName}: ${depSpec}`,
        );
      }
    }

    const archiveEntries = new Set(
      execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean),
    );
    for (const expected of item.expectedFiles) {
      assert(archiveEntries.has(expected), `Packed tarball for ${name} missing ${expected}`);
    }

    packedSummary.push(`${name}@${pkgJson.version} -> ${tgzPath}`);
  }

  for (const line of packedSummary) {
    process.stdout.write(`PASS ${line}\n`);
  }
} finally {
  if (!PACK_PERSISTENT) {
    rmSync(destDir, { recursive: true, force: true });
  }
}
