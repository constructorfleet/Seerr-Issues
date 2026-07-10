const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const suffix = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
