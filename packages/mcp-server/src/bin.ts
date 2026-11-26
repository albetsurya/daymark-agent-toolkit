#!/usr/bin/env node
import { startDaymarkHttpServer, startDaymarkStdioServer } from './index.js';

function parseFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

const argv = process.argv.slice(2);

if (argv.includes('--http')) {
  const host = parseFlagValue(argv, '--host') ?? process.env.DAYMARK_MCP_HOST ?? '127.0.0.1';
  const portRaw = parseFlagValue(argv, '--port') ?? process.env.DAYMARK_MCP_PORT ?? '8787';
  const port = Number(portRaw);
  const allowAnyHost =
    argv.includes('--allow-any-host') || process.env.DAYMARK_MCP_ALLOW_ANY_HOST === '1';

  startDaymarkHttpServer({
    host,
    port: Number.isInteger(port) && port >= 0 ? port : 8787,
    allowAnyHost,
  })
    .then((handle) => {
      process.stderr.write(`Daymark Remote MCP (Streamable HTTP) listening at ${handle.mcpUrl}\n`);
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
        `Failed to start Daymark HTTP MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
} else {
  startDaymarkStdioServer();
}
