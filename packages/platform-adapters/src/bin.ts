#!/usr/bin/env node
import { generateAllPlatformPackages, verifyGeneratedPlatformPackages } from './index.js';

const cmd = process.argv[2];
const isLocal = process.argv.includes('--local');

if (cmd === 'pack') {
  const outputs = generateAllPlatformPackages({
    mode: isLocal ? 'local' : 'portable',
    nodeExecutable: process.execPath,
  });
  for (const out of outputs) {
    process.stdout.write(`Packed ${out.target}: ${out.files.length} files -> ${out.outputDir}\n`);
  }
} else if (cmd === 'verify') {
  const results = verifyGeneratedPlatformPackages();
  let failed = false;
  for (const res of results) {
    if (res.valid) {
      process.stdout.write(
        `PASS ${res.target} (${res.checkedFiles} files, ${res.skillsCount} skills)\n`,
      );
    } else {
      failed = true;
      process.stderr.write(`FAIL ${res.target}: ${res.errors.join('; ')}\n`);
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
} else {
  process.stderr.write('Usage: platform-adapters <pack|verify>\n');
  process.exitCode = 1;
}
