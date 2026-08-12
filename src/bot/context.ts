import type { Context } from "grammy";
import type { AppConfig } from "../config.js";
import type { BotLocale } from "../locale.js";
import type { OpenDatabase } from "../storage/database.js";
import type { ZoomClient } from "../zoom.js";

export type AppContext = Context & {
  config: AppConfig;
  database: OpenDatabase;
  runtime: BotRuntime;
  locale: BotLocale;
};

export type BotRuntime = {
  bot: import("grammy").Bot<AppContext>;
  config: AppConfig;
  database: OpenDatabase;
  zoom: ZoomClient;
};
