import cron from "node-cron";
import { sendReminder, sendWeeklySummary } from "../integrations/slack.js";
import type { Config } from "../types/index.js";

export function startScheduler(config: Config) {
  const [hours, minutes] = config.user.reminderTime.split(":").map(Number);

  // Daily reminder: Mon-Fri at configured time
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
      } catch (err) {
        console.error("Erreur rappel:", err);
      }
    },
    { timezone: config.user.timezone }
  );

  // Friday summary: 1 hour after daily reminder, Fridays only
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
