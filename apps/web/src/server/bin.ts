#!/usr/bin/env node
import { startDaymarkWebServer } from './index.js';

function parseFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

const argv = process.argv.slice(2);
const host = parseFlagValue(argv, '--host') ?? process.env.DAYMARK_WEB_HOST ?? '127.0.0.1';
const portRaw = parseFlagValue(argv, '--port') ?? process.env.DAYMARK_WEB_PORT ?? '3456';
const parsedPort = Number(portRaw);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 3456;

startDaymarkWebServer({ host, port })
  .then((handle) => {
    process.stdout.write(`Daymark Web Dashboard listening at ${handle.url}\n`);
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  })
  .catch((err) => {
    process.stderr.write(
      `Failed to start Daymark Web Dashboard: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
