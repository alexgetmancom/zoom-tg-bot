# zoom-tg-bot

Personal Telegram inline bot for creating Zoom meetings and delivering official Zoom summaries.

The runtime is TypeScript on Bun inside Docker Compose. It combines grammY, Hono, Zod, Bun SQLite, Zoom Server-to-Server OAuth, and one background worker process.

## Features

- Quick, scheduled, and recurring Zoom meetings with confirmation
- Invitees passed to Zoom and optional Google Calendar push
- Upcoming meeting list, history, reminders, follow-ups, cancellation, duplication, and rescheduling
- Official Zoom summary delivery with an optional IMAP fallback
- Optional transcript delivery when cloud recording is enabled
- SQLite history with completed-meeting timestamps and delivered summary text
- English interface by default; Russian is available in bot settings

## Quick start

```bash
cp .env.example .env
bun install
bun run check
bun run dev
```

The bot needs `TELEGRAM_BOT_TOKEN`, one or more IDs in `ALLOWED_USERS`, and the Zoom OAuth variables listed in [.env.example](./.env.example).

Use the bot inline in any Telegram chat:

```text
@bot 14:30
@bot call 10.04 16:30 90m project review user@example.com
@bot lesson tomorrow 11:00 student@example.com
@bot every mon 16:30 team call
```

Select a result and press Confirm. Typing a query alone never creates a Zoom meeting.

## Commands

- `/start` or `/help` — help
- `/templates` — meeting templates and examples
- `/list` — upcoming meetings
- `/history` — meeting history
- `/settings` — bot settings, including language
- `/health` — service and database status

## Project layout

- `src/` — production TypeScript runtime
- `src/bot/` — Telegram handlers and inline flow
- `src/parser.ts` — inline query parser
- `src/storage/database.ts` — SQLite state and user settings
- `src/artifact-worker.ts` — webhook, summary, transcript, and IMAP processing
- `tests/` — focused Bun tests
- `GUIDE.md` — operator guide

Secrets and runtime SQLite files stay outside git.
