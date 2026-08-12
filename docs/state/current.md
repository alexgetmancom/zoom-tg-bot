# Current state

- Last checked: `2026-08-12`
- Canonical runtime: `src/`
- Start command: `bun run start`
- Production service: `zoom-telegram-bot.service` on VPS `5.129.238.194`
- Runtime process: one Bun process for Telegram, HTTP, Zoom webhooks, reminders, and artifact workers
- Default bot language: English
- Optional bot language: Russian, stored in the `user_settings` SQLite table
- Database: SQLite outside git, compatible with the existing meeting record shape
- Production env: `/home/deploy/telemostbot/.env`

## Operator checks

```bash
bun run check
ssh tw-nl 'systemctl is-active zoom-telegram-bot.service'
ssh tw-nl 'curl -fsS http://127.0.0.1:8799/healthz && curl -fsS http://127.0.0.1:8799/readyz'
```

## Repository boundaries

The repository contains only the TypeScript runtime, focused tests, configuration examples, and English operator documentation. Secrets, runtime data, raw exports, generated notes, and production databases remain outside git.
