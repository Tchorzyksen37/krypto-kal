// logger.ts – minimal structured logger.
// Line format: "<ISO time> <LEVEL> [scope] message key=value ..."
// Level comes from LOG_LEVEL (debug | info | warn | error), default info.
// warn and error go to stderr, everything else to stdout.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

function parseLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase();
  return v && v in ORDER ? (v as LogLevel) : "info";
}

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

// Plain tokens stay bare; anything with spaces or special characters is JSON-quoted.
function formatValue(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === "string") return /^[\w.:/,@+-]+$/.test(v) ? v : JSON.stringify(v);
  return JSON.stringify(v) ?? String(v);
}

export function createLogger(scope: string): Logger {
  const at = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const kv = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(" ");
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${kv ? ` ${kv}` : ""}`;
    (ORDER[level] >= ORDER.warn ? console.error : console.log)(line);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

// UNIX seconds -> "2026-09-29T12:00:00Z" for readable time ranges in logs.
export const isoTime = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
