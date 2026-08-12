export const RELATIVE_DATE_WORDS: Record<string, number> = {
  today: 0,
  tomorrow: 1,
  сегодня: 0,
  завтра: 1,
  послезавтра: 2,
};

export const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  фев: 2,
  feb: 2,
  february: 2,
  февраль: 2,
  февраля: 2,
  мар: 3,
  march: 3,
  март: 3,
  марта: 3,
  апр: 4,
  april: 4,
  апрель: 4,
  апреля: 4,
  май: 5,
  мая: 5,
  may: 5,
  июн: 6,
  june: 6,
  июнь: 6,
  июня: 6,
  июл: 7,
  july: 7,
  июль: 7,
  июля: 7,
  авг: 8,
  august: 8,
  август: 8,
  августа: 8,
  сен: 9,
  sep: 9,
  sept: 9,
  september: 9,
  сент: 9,
  сентябрь: 9,
  сентября: 9,
  окт: 10,
  october: 10,
  октябрь: 10,
  октября: 10,
  ноя: 11,
  november: 11,
  ноябрь: 11,
  ноября: 11,
  дек: 12,
  december: 12,
  декабрь: 12,
  декабря: 12,
};

export const WEEKDAY_MAP: Record<string, number> = {
  sun: 7,
  sunday: 7,
  вс: 7,
  воскресенье: 7,
  mon: 1,
  monday: 1,
  пн: 1,
  понедельник: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  вт: 2,
  вторник: 2,
  wed: 3,
  wednesday: 3,
  ср: 3,
  среда: 3,
  thu: 4,
  thursday: 4,
  чт: 4,
  четверг: 4,
  fri: 5,
  friday: 5,
  пт: 5,
  пятница: 5,
  sat: 6,
  saturday: 6,
  сб: 6,
  суббота: 6,
};

export const TEMPLATE_ALIASES: Record<"quick" | "lesson" | "call", string[]> = {
  quick: ["quick", "fast", "быстрая"],
  lesson: ["lesson", "урок", "lesson:"],
  call: ["call", "meeting", "созвон"],
};

export const DURATION_HOUR_UNITS = ["h", "hr", "hrs", "ч"];

export const SUMMARY_EMAIL_MARKERS = ["summary", "meeting summary", "ai companion", "итоги", "конспект", "резюме"];

export const DURATION_RE = /(?<!\S)(\d+)\s*(m|min|mins|h|hr|hrs|м|мин|ч)(?!\S)/iu;
export const WORD_DATE_RE = /\b(\d{1,2})\s+([A-Za-zА-Яа-яЁё]+\.?)(?:\s+(\d{4}|\d{2}(?!:)))?(?=$|[^\p{L}\p{N}_])/giu;
export const WEEKLY_RECURRENCE_RE = /^(?:каждый|every)\s+([^\d]+?)\s+(\d{1,2}:\d{2})(?:\s+|$)(.*)$/i;
export const MONTHLY_RECURRENCE_RE = /^(?:каждое|every)\s+(\d{1,2})\s*(?:число|day)?\s+(\d{1,2}:\d{2})(?:\s+|$)(.*)$/i;
export const SCHEDULE_TOKEN_RE = /(?<![\p{L}\p{N}_])(?:каждый|каждое|every|число|day)(?![\p{L}\p{N}_])/giu;
