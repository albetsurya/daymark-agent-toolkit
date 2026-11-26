#!/usr/bin/env node
import { runDaymarkCli } from './index.js';

const exitCode = await runDaymarkCli(process.argv);
process.exitCode = exitCode;
