# Project overview

- Name: `zoom-tg-bot`
- Purpose: personal Telegram inline bot for Zoom meeting creation and post-meeting artifacts
- Runtime: TypeScript/Bun in `src/index.ts`
- Operator: one Telegram user and one Zoom host
- Persistence: local SQLite outside git
- Production host: VPS `5.129.238.194`
- Interface: English by default, Russian through the bot language setting

The TypeScript runtime is the only supported production path. Shared infrastructure and credentials live outside this repository.
