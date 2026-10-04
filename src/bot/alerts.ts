// alerts.ts – makes problems visible instead of leaving them in SQLite. After every trader step, new incidents and
// changes of the halt state become alerts, sent to every sink: the log, and a note in the Obsidian vault
// (<BRAIN_DIR>/output/bot/alerts.md, newest at the bottom). A cursor in the store makes each incident alert once,
// across restarts. Only the trader process sends alerts; the watchdog's incidents reach them through the store.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../core/logger.ts";
import type { BotStore } from "./bot-store.ts";
import { loadEngineRecord } from "./engine-state.ts";

const log = createLogger("bot-alerts");

export interface Alert {
  tMs: number;
  level: "incident" | "halt" | "recovered";
  kind: string;
  detail: string;
}

export interface AlertSink {
  send(alerts: Alert[]): Promise<void>;
}

const CURSOR_KEY = "alerts:cursor";
const HALT_KEY = "alerts:halt";

// New alerts since the last call. Advances the cursor; a sink failure later does not resend (the store keeps the record).
export function collectAlerts(store: BotStore, nowMs: number): Alert[] {
  const cursor = Number(store.getKv(CURSOR_KEY) ?? "0");
  const fresh = store.incidentsAfter(Number.isFinite(cursor) ? cursor : 0);
  const alerts: Alert[] = fresh.map((i) => ({ tMs: i.tMs, level: "incident", kind: i.kind, detail: i.detail }));
  if (fresh.length) store.setKv(CURSOR_KEY, String(fresh[fresh.length - 1]!.id));

  let haltKey = "";
  try {
    const rec = loadEngineRecord(store);
    if (rec.state === "HALTED" && rec.halt) {
      haltKey = `${rec.halt.reason}@${rec.sinceMs}`;
      if (store.getKv(HALT_KEY) !== haltKey) {
        const how = rec.halt.manualAck ? "needs `npm run bot -- ack-halt`" : rec.halt.untilMs ? `clears at ${new Date(rec.halt.untilMs).toISOString()}` : "";
        alerts.push({ tMs: nowMs, level: "halt", kind: rec.halt.reason, detail: `the bot is HALTED${how ? `; ${how}` : ""}` });
      }
    } else if (store.getKv(HALT_KEY)) {
      alerts.push({ tMs: nowMs, level: "recovered", kind: "halt_cleared", detail: `the bot left HALTED and is ${rec.state}` });
    }
  } catch (e) {
    haltKey = "unreadable";
    if (store.getKv(HALT_KEY) !== haltKey) {
      alerts.push({ tMs: nowMs, level: "halt", kind: "engine_record_unreadable", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  store.setKv(HALT_KEY, haltKey);
  return alerts;
}

export const logSink: AlertSink = {
  async send(alerts) {
    for (const a of alerts) {
      if (a.level === "recovered") log.info(`${a.kind}: ${a.detail}`);
      else log.error(`${a.level.toUpperCase()} ${a.kind}: ${a.detail}`);
    }
  },
};

const BOT_DIR = ["output", "bot"];

export class VaultAlertSink implements AlertSink {
  readonly path: string;
  constructor(brainDir: string) {
    this.path = join(brainDir, ...BOT_DIR, "alerts.md");
  }
  async send(alerts: Alert[]): Promise<void> {
    if (!alerts.length) return;
    await mkdir(join(this.path, ".."), { recursive: true });
    if (!existsSync(this.path)) {
      await writeFile(this.path, "# Bot alerts (dry-run)\n\nNewest at the bottom. Incidents come from the bot's store; see `npm run bot -- status`.\n\n", "utf8");
    }
    const lines = alerts.map((a) => {
      const tag = a.level === "incident" ? "INCIDENT" : a.level === "halt" ? "HALT" : "OK";
      return `- ${new Date(a.tMs).toISOString()} **${tag}** \`${a.kind}\`: ${a.detail.replace(/\r?\n/g, " ")}`;
    });
    await appendFile(this.path, `${lines.join("\n")}\n`, "utf8");
  }
}

// Sends to every sink; a failing sink is logged and does not stop the others or the bot.
export async function dispatch(alerts: Alert[], sinks: AlertSink[]): Promise<void> {
  if (!alerts.length) return;
  for (const s of sinks) {
    try {
      await s.send(alerts);
    } catch (e) {
      log.error("alert sink failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// The daily report note in the vault (overwritten on every refresh).
export async function writeVaultReport(brainDir: string, day: string, markdown: string): Promise<string> {
  const dir = join(brainDir, ...BOT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `report-${day}.md`);
  await writeFile(path, markdown, "utf8");
  return path;
}

export async function readVaultAlerts(brainDir: string): Promise<string | undefined> {
  const path = join(brainDir, ...BOT_DIR, "alerts.md");
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}
