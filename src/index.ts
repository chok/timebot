import { loadConfig } from "./config/index.js";
import { createSlackApp } from "./integrations/slack.js";
import { startScheduler } from "./services/scheduler.js";
import { getDayStatus, formatDayStatus, getCurrentTicketForUser } from "./services/timesheet.js";

async function main() {
  const config = loadConfig();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  console.log(`\nTimebot - ${today}`);
  console.log(`User: ${config.user.jiraAccountId}`);
  console.log(`Project: ${config.user.workProject} | Country: ${config.user.country}\n`);

  // Show today's status
  const status = await getDayStatus(config, today);
  console.log(formatDayStatus(status));

  if (status.remainingHours > 0) {
    const ticket = await getCurrentTicketForUser(config);
    if (ticket) {
      console.log(`Ticket en cours: ${ticket.key} - ${ticket.fields.summary}`);
      console.log(`${status.remainingHours}h a logger sur ${ticket.key}`);
    }
  }

  // Start Slack bot
  const app = createSlackApp();
  await app.start();
  console.log("\nSlack bot demarre (Socket Mode).");

  // Start daily reminder scheduler
  startScheduler(config);

  console.log("Timebot pret. Ctrl+C pour arreter.\n");
}

main().catch(console.error);
