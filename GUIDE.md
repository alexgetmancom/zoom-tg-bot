# Operator guide

## What it is

`zoom-tg-bot` is a single-user Telegram inline bot that creates meetings for one Zoom host. The TypeScript/Bun process inside Docker owns Telegram, the health and Zoom webhook endpoints, reminders, and post-meeting artifact workers.

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

Enter the meeting time in Alex's configured timezone. To show a client's local time, append a supported city after ` - `:

```text
13 August 12:00 Savely - Miami
14 August 11:00 Lesson - Tel Aviv
```

The topic excludes the city suffix. The preview shows Alex's time and the client's local time. Miami uses `America/New_York`, and Tel Aviv uses `Asia/Jerusalem`; daylight-saving changes are calculated automatically for the meeting date. The supported aliases currently cover Miami, New York, Los Angeles, Chicago, Tel Aviv, Israel, Jerusalem, London, Berlin, and Dubai.

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

For summaries, enable the Zoom Meeting Summary API and set `ZOOM_WEBHOOK_SECRET_TOKEN`. The artifact worker accepts Zoom webhooks, polls the summary API, sends the exact Markdown document to Telegram, and stores that document in SQLite with the meeting completion timestamp.

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

## Production

The VPS production runtime is one Docker Compose `app` container from `/home/deploy/telemostbot`. The container reads secrets from `/home/deploy/telemostbot/.env` and stores SQLite in `/home/deploy/telemostbot/data`. The host port remains `8799`.

The production container must be healthy after a deploy:

```bash
cd /home/deploy/telemostbot
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8799/healthz
curl -fsS http://127.0.0.1:8799/readyz
docker compose logs --tail=100 app
```

## Boundaries

- Never commit `.env`, OAuth credentials, Telegram tokens, or SQLite files.
- The repository contains only the TypeScript runtime, tests, examples, and operator documentation.
- Russian UI copy belongs in the Russian locale catalog. English is the source locale and the default.
