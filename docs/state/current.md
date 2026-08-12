# Current state

- Last checked: `2026-08-12`
- Canonical runtime: `src/`
- Start command: `docker compose up -d --build`
- Production service: Docker Compose `app` on VPS `5.129.238.194`
- Runtime process: one Bun container for Telegram, HTTP, Zoom webhooks, reminders, and artifact workers
- Default bot language: English
- Optional bot language: Russian, stored in the `user_settings` SQLite table
- Database: `/home/deploy/telemostbot/data/bot_state.sqlite3`, mounted into the container and kept outside git
- Completed meetings: `completed_at` and the exact Telegram summary document are stored in the `meetings` table
- Production env: `/home/deploy/telemostbot/.env`

## Operator checks

```bash
bun run check
ssh tw-nl 'cd /home/deploy/telemostbot && docker compose ps'
ssh tw-nl 'curl -fsS http://127.0.0.1:8799/healthz && curl -fsS http://127.0.0.1:8799/readyz'
```

## Repository boundaries

The repository contains only the TypeScript runtime, focused tests, configuration examples, and English operator documentation. Secrets and production databases remain outside git.
