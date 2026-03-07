import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { sendReminder, sendWeeklySummary } from "../integrations/slack.js";
import type { Config } from "../types/index.js";

const STATE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.last_reminder"
);

function readLastReminder(): string | null {
  try {
    return readFileSync(STATE_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function writeLastReminder(date: string) {
  writeFileSync(STATE_FILE, date, "utf-8");
}

/** Get local date string in the configured timezone */
function localDate(config: Config, d = new Date()): string {
  const parts = d.toLocaleDateString("en-CA", { timeZone: config.user.timezone });
  return parts; // "YYYY-MM-DD"
}

/** Get the day of week (1=Mon..7=Sun) for a date string */
function dayOfWeek(date: string): number {
  const d = new Date(date + "T12:00:00");
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** Get current local hour as float (e.g. 17.5 for 17:30) */
function localHourNow(config: Config): number {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", {
    timeZone: config.user.timezone,
    hour12: false,
  });
  const [h, m] = timeStr.split(":").map(Number);
  return h + m / 60;
}

/** Compute the date of the last expected reminder (today or last workday) */
function lastExpectedReminderDate(config: Config): string {
  const today = localDate(config);
  const dow = dayOfWeek(today);
  const [hours, minutes] = config.user.reminderTime.split(":").map(Number);
  const reminderHour = hours + minutes / 60;
  const nowHour = localHourNow(config);

  // If it's a workday and past reminder time, expected = today
  if (dow >= 1 && dow <= 5 && nowHour >= reminderHour) {
    return today;
  }

  // Otherwise walk back to the previous workday
  const d = new Date(today + "T12:00:00");
  let steps = 0;
  do {
    d.setDate(d.getDate() - 1);
    steps++;
  } while ((d.getDay() === 0 || d.getDay() === 6) && steps < 4);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function checkMissedReminder(config: Config) {
  const expected = lastExpectedReminderDate(config);
  const last = readLastReminder();

  if (last && last >= expected) return; // already sent

  console.log(`[${new Date().toISOString()}] Rappel manque pour ${expected}, envoi...`);
  try {
    await sendReminder(config);
    writeLastReminder(expected);

    // If the missed date was a Friday, also send the weekly summary
    if (dayOfWeek(expected) === 5) {
      await sendWeeklySummary(config);
    }
  } catch (err) {
    console.error("Erreur rappel rattrapage:", err);
  }
}

export function startScheduler(config: Config) {
  const [hours, minutes] = config.user.reminderTime.split(":").map(Number);

  // ── Check for missed reminder on startup ──
  checkMissedReminder(config);

  // ── Wake from sleep detection ──
  // Heartbeat every 60s; if gap > 5min, machine likely slept
  let lastTick = Date.now();
  setInterval(() => {
    const elapsed = Date.now() - lastTick;
    lastTick = Date.now();
    if (elapsed > 5 * 60 * 1000) {
      console.log(`[${new Date().toISOString()}] Reveil detecte (${Math.round(elapsed / 60000)}min de pause).`);
      checkMissedReminder(config);
    }
  }, 60_000);

  // ── Daily reminder: Mon-Fri at configured time ──
  const dailyCron = `${minutes} ${hours} * * 1-5`;
  console.log(
    `Scheduler: rappel quotidien a ${config.user.reminderTime} (${config.user.timezone}) — cron: ${dailyCron}`
  );

  cron.schedule(
    dailyCron,
    async () => {
      console.log(`[${new Date().toISOString()}] Rappel quotidien...`);
      try {
        await sendReminder(config);
        writeLastReminder(localDate(config));
      } catch (err) {
        console.error("Erreur rappel:", err);
      }
    },
    { timezone: config.user.timezone }
  );

  // ── Friday summary: 1 hour after daily reminder ──
  const summaryHour = hours + 1 > 23 ? hours : hours + 1;
  const fridayCron = `${minutes} ${summaryHour} * * 5`;
  console.log(
    `Scheduler: resume hebdo le vendredi a ${summaryHour}:${String(minutes).padStart(2, "0")} — cron: ${fridayCron}`
  );

  cron.schedule(
    fridayCron,
    async () => {
      console.log(`[${new Date().toISOString()}] Resume hebdomadaire...`);
      try {
        await sendWeeklySummary(config);
      } catch (err) {
        console.error("Erreur resume:", err);
      }
    },
    { timezone: config.user.timezone }
  );
}
