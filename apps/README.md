# Applications (`apps/`)

- [`apps/web`](./web): Standalone React + TypeScript Web Dashboard served by a local Node.js HTTP server bound strictly to `127.0.0.1` (`daymark-web`). Communicates exclusively through `/api/*` using `@daymark/core` and `@daymark/storage-sqlite` with Host/Origin checks and HMAC CSRF protection.
