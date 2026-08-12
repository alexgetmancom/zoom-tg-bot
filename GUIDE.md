# Operator guide

## What it is

`zoom-tg-bot` is a single-user Telegram inline bot that creates meetings for one Zoom host. The TypeScript/Bun process owns Telegram, the health and Zoom webhook endpoints, reminders, and post-meeting artifact workers.

## Telegram usage

Open any Telegram chat and type the bot inline:

```text
@bot 14:30
@bot 11.04 16:30
@bot 13 August 12:00 Test
@bot call 11.04 16:30 90m user@example.com project review
@bot lesson tomorrow 11:00 student@example.com
@bot every mon 16:30 team call
@bot every 15 day 12:00 lesson
```

The parser accepts English and the existing Russian date, weekday, relative-date, duration, and template aliases. The interface language is English by default. Use `/settings` and select Russian when the bot should speak Russian.

Typing only prepares inline results. A Zoom meeting is created after the Confirm button is pressed.

## Commands

- `/start` or `/help` — help and examples
- `/templates` — template names, default topics, and examples
- `/list` — upcoming meetings stored by the bot
- `/history` — recently created meetings
- `/settings` or `/language` — choose English or Russian
- `/health` — database and worker settings

After a meeting is created, the card can open, move the meeting by one hour or one day, duplicate it, or cancel it.

## Configuration

Copy [.env.example](./.env.example) to `.env`. Required production values are:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_USERS`
- `ZOOM_ACCOUNT_ID`
- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`
- `ZOOM_HOST_USER_ID_OR_EMAIL`

The database defaults to `./data/bot_state.sqlite3`. It stores pending inline actions, meeting records, webhook idempotency, artifact state, and the selected bot language. It is intentionally ignored by git.

## Zoom

The bot uses Zoom Server-to-Server OAuth and creates normal or recurring meetings through the Zoom API. It requests Zoom's native Google Calendar push; it does not write to Google Calendar directly.

For summaries, enable the Zoom Meeting Summary API and set `ZOOM_WEBHOOK_SECRET_TOKEN`. The artifact worker accepts Zoom webhooks, polls the summary API, delivers official summaries to Telegram, and can export notes through `GIT_NOTES_REPO_URL`.

Cloud recording is disabled by default. Set `ZOOM_AUTO_RECORDING=cloud` only when transcript delivery is needed. IMAP is an optional fallback for summary emails and is enabled only when all IMAP credentials are present.

The webhook health endpoint is:

```text
http://127.0.0.1:8080/zoom/webhook/healthz
```

## Local checks

```bash
bun install
bun run check
bun run dev
```

`bun run check` runs Biome, strict TypeScript, Bun tests, and the production build.

Historical export is available when needed:

```bash
bun run start:export -- --from 2026-04-01 --to 2026-04-10
```

## Production

The VPS service is `zoom-telegram-bot.service` and runs one Bun process from `/home/deploy/telemostbot`:

```ini
[Service]
User=deploy
WorkingDirectory=/home/deploy/telemostbot
EnvironmentFile=-/home/deploy/telemostbot/.env
ExecStart=/usr/local/bin/bun /home/deploy/telemostbot/dist/src/index.js
Restart=always
RestartSec=5
```

The service must be healthy before a deploy is considered complete:

```bash
sudo systemctl is-active zoom-telegram-bot.service
curl -fsS http://127.0.0.1:8799/healthz
curl -fsS http://127.0.0.1:8799/readyz
```

## Boundaries

- Never commit `.env`, OAuth credentials, Telegram tokens, SQLite files, raw exports, or generated meeting notes.
- The repository contains only the TypeScript runtime, tests, examples, and operator documentation.
- Russian UI copy belongs in the Russian locale catalog. English is the source locale and the default.
