# AGENTS.md

## Scope

Keep this repository focused on the Zoom Telegram bot, its TypeScript runtime, tests, configuration examples, and operator documentation.

Do not commit `.env`, credentials, runtime SQLite databases, raw exports, or generated meeting-note repositories.

## Language

The repository is English-only: code, identifiers, comments, logs, errors, tests, documentation, and commit messages. Russian is product data only and belongs in the bot's Russian locale catalog or parser input lexicon.

English is the source locale and the default bot language. The Russian locale is selected from `/settings` and is persisted per Telegram user.

## Working rules

- Work directly on `main`.
- Keep one production path: the TypeScript/Bun runtime.
- Delete obsolete code instead of preserving compatibility layers.
- Update `GUIDE.md` when operator usage or configuration changes.
- Update `docs/state/current.md` when runtime behavior or persisted data changes.
- Add tests for parser, persistence, and wiring changes that can fail silently.
- Run `bun run check` before publishing.
