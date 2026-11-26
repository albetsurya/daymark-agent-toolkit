#!/usr/bin/env node
/**
 * scripts/verify-docs-sync.mjs
 *
 * Automated verification to prevent documentation and contract drift:
 * 1. Validates that all internal relative Markdown links point to existing files.
 * 2. Ensures all workspace packages are documented in ARCHITECTURE.md and RELEASE_STRATEGY.md.
 * 3. Ensures all CLI subcommands are documented in README.md or PRODUCT_SPEC.md.
 * 4. Ensures all 16 MCP tool names are documented in docs/MCP_CONTRACT.md and README.md.
 * 5. Ensures all typed Daymark error codes are documented in docs/MCP_CONTRACT.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const errors = [];

function check(assertion, message) {
  if (!assertion) {
    errors.push(message);
  }
}

console.log('🔍 Checking Daymark documentation and contract synchronization...\n');

// 1. Gather all markdown files
function findMarkdownFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === 'dist-pack' ||
      entry.name === '.changeset'
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const mdFiles = findMarkdownFiles(ROOT);
console.log(`[1/5] Validating link integrity across ${mdFiles.length} Markdown files...`);

const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
let checkedLinks = 0;

for (const file of mdFiles) {
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const rawTarget = match[2].trim();
    // Ignore external links, mailto, and pure in-page anchors
    if (
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('#')
    ) {
      continue;
    }

    const cleanPath = rawTarget.split('#')[0].split('?')[0];
    if (!cleanPath) {
      continue;
    }

    checkedLinks++;
    const resolvedTarget = resolve(dirname(file), cleanPath);
    if (!existsSync(resolvedTarget)) {
      errors.push(
        `Broken link in ${file.replace(ROOT, '')}: "${rawTarget}" -> target not found at ${resolvedTarget.replace(ROOT, '')}`,
      );
    }
  }
}
console.log(`      Checked ${checkedLinks} relative links.`);

// 2. Workspace package list check
console.log('[2/5] Checking workspace package topology coverage...');
const workspacePackages = [];
for (const base of ['packages', 'apps']) {
  const dir = join(ROOT, base);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const pkgJson = join(dir, name, 'package.json');
      if (existsSync(pkgJson)) {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (pkg.name) {
          workspacePackages.push({ name: pkg.name, dir: `${base}/${name}`, private: Boolean(pkg.private) });
        }
      }
    }
  }
}

const archDoc = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
const releaseDoc = readFileSync(join(ROOT, 'docs/RELEASE_STRATEGY.md'), 'utf8');

for (const pkg of workspacePackages) {
  check(
    archDoc.includes(pkg.name) || archDoc.includes(pkg.dir),
    `ARCHITECTURE.md does not reference workspace package: ${pkg.name} (${pkg.dir})`,
  );
  if (!pkg.private) {
    check(
      releaseDoc.includes(pkg.name),
      `RELEASE_STRATEGY.md does not document public publishable package: ${pkg.name}`,
    );
  }
}
console.log(`      Checked ${workspacePackages.length} workspace packages in architecture and release docs.`);

// 3. CLI commands check
console.log('[3/5] Checking CLI commands documentation...');
const cliFile = readFileSync(join(ROOT, 'packages/cli/src/index.ts'), 'utf8');
const cmdRegex = /([a-zA-Z0-9_]+)\s*\.command\(['"]([^'"]+)['"]\)/g;
const cliCommands = [];
let cmdMatch;
while ((cmdMatch = cmdRegex.exec(cliFile)) !== null) {
  const receiver = cmdMatch[1];
  const rawCmd = cmdMatch[2].split(' ')[0];
  let fullCmd = rawCmd;
  if (receiver.endsWith('Cmd')) {
    const parent = receiver.replace('Cmd', '');
    fullCmd = `${parent} ${rawCmd}`;
  }
  if (!cliCommands.includes(fullCmd)) {
    cliCommands.push(fullCmd);
  }
}

const readmeDoc = readFileSync(join(ROOT, 'README.md'), 'utf8');
const productSpecDoc = readFileSync(join(ROOT, 'docs/PRODUCT_SPEC.md'), 'utf8');

for (const cmd of cliCommands) {
  const inReadme = readmeDoc.includes(`daymark ${cmd}`) || readmeDoc.includes(cmd);
  const inSpec = productSpecDoc.includes(`daymark ${cmd}`) || productSpecDoc.includes(`\`${cmd}\``) || productSpecDoc.includes(cmd);
  check(
    inReadme || inSpec,
    `CLI command "daymark ${cmd}" is not documented in README.md or docs/PRODUCT_SPEC.md`,
  );
}
console.log(`      Checked ${cliCommands.length} CLI commands (${cliCommands.join(', ')}).`);

// 4. MCP Tools check
console.log('[4/5] Checking MCP tools documentation parity...');
const toolsFile = readFileSync(join(ROOT, 'packages/mcp-server/src/tools.ts'), 'utf8');
const toolRegex = /name:\s*['"](daymark_[a-z0-9_]+)['"]/g;
const mcpTools = [];
let toolMatch;
while ((toolMatch = toolRegex.exec(toolsFile)) !== null) {
  if (!mcpTools.includes(toolMatch[1])) {
    mcpTools.push(toolMatch[1]);
  }
}

const mcpContractDoc = readFileSync(join(ROOT, 'docs/MCP_CONTRACT.md'), 'utf8');
for (const tool of mcpTools) {
  check(
    mcpContractDoc.includes(tool),
    `docs/MCP_CONTRACT.md missing documentation for tool: ${tool}`,
  );
  check(
    readmeDoc.includes(tool),
    `README.md missing documentation for tool: ${tool}`,
  );
}
console.log(`      Checked ${mcpTools.length} MCP tools.`);

// 5. Error codes check
console.log('[5/5] Checking ErrorCodeSchema synchronization...');
const contractsFile = readFileSync(join(ROOT, 'packages/contracts/src/index.ts'), 'utf8');
const errSchemaMatch = contractsFile.match(/export const ErrorCodeSchema = z\.enum\(\[([\s\S]*?)\]\);/);
if (!errSchemaMatch) {
  errors.push('Could not parse ErrorCodeSchema from packages/contracts/src/index.ts');
} else {
  const errorCodes = errSchemaMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter((s) => s.length > 0);

  for (const code of errorCodes) {
    check(
      mcpContractDoc.includes(code),
      `docs/MCP_CONTRACT.md does not document Daymark error code: "${code}"`,
    );
  }
  console.log(`      Checked ${errorCodes.length} typed Daymark error codes.`);
}

console.log('');
if (errors.length > 0) {
  console.error(`❌ Documentation and Contract Drift Detected (${errors.length} errors):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log('✅ All documentation, workspace packages, CLI commands, MCP tools, and error contracts are fully synchronized!\n');
