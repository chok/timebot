import { App } from "@slack/bolt";
import { getEnv } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import {
  getDayStatus,
  formatDayStatus,
  getWeekStatus,
  getCurrentTicketForUser,
  scanUnfilledDays,
} from "../services/timesheet.js";
import { createWorklog } from "./tempo.js";
import { analyzeWorkDescription, analyzeGitHubActivity } from "./claude.js";
import { createIssue, getIssue } from "./jira.js";
import { getActivityForPeriod } from "./github.js";
import type { Config, DayStatus, GitHubActivity } from "../types/index.js";

let app: InstanceType<typeof App>;

interface PendingEntry {
  issueKey: string;
  issueId: number;
  summary: string;
  hours: number;
  date: string;
}

interface CatchupWeek {
  monday: string;
  days: DayStatus[];
  ghActivity: GitHubActivity[];
}

interface ConversationState {
  dayStatus: DayStatus;
  pendingEntries?: PendingEntry[];
  catchupWeeks?: CatchupWeek[];
  currentWeekIndex?: number;
  githubActivity?: GitHubActivity[];
}

const conversations = new Map<string, ConversationState>();

export function createSlackApp(): InstanceType<typeof App> {
  app = new App({
    token: getEnv("SLACK_BOT_TOKEN"),
    appToken: getEnv("SLACK_APP_TOKEN"),
    socketMode: true,
  });

  registerHandlers();
  return app;
}

// ──────────────────────────────────────────────
// Central logging — ONLY called after explicit user confirmation
// ──────────────────────────────────────────────
async function executeConfirmedLog(
  userId: string,
  entries: PendingEntry[],
  config: Config
): Promise<string> {
  const results: string[] = [];

  for (const entry of entries) {
    await createWorklog({
      issueId: entry.issueId,
      accountId: config.user.jiraAccountId,
      date: entry.date,
      seconds: entry.hours * 3600,
      description: entry.summary,
    });
    results.push(`${entry.hours}h sur ${entry.issueKey}`);
  }

  return results.join(", ");
}

// ──────────────────────────────────────────────
// Date helpers
// ──────────────────────────────────────────────
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr(): string {
  return formatLocalDate(new Date());
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}

function dayName(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });
}

// ──────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────
function registerHandlers() {
  // ── Slash commands ──
  app.command("/timebot", async ({ ack, respond, command }: any) => {
    await ack();
    const config = loadConfig();
    if (command.user_id !== config.user.slackUserId) return;
    const say = (msg: string | Record<string, any>) =>
      respond(typeof msg === "string" ? { text: msg, response_type: "ephemeral" } : { ...msg, response_type: "ephemeral" });
    await handleStatus(say, config);
  });

  app.command("/semaine", async ({ ack, respond, command }: any) => {
    await ack();
    const config = loadConfig();
    if (command.user_id !== config.user.slackUserId) return;
    const say = (msg: string | Record<string, any>) =>
      respond(typeof msg === "string" ? { text: msg, response_type: "ephemeral" } : { ...msg, response_type: "ephemeral" });
    await handleWeekStatus(say, config);
  });

  app.command("/rattrapage", async ({ ack, respond, command }: any) => {
    await ack();
    const config = loadConfig();
    if (command.user_id !== config.user.slackUserId) return;
    const say = (msg: string | Record<string, any>) =>
      respond(typeof msg === "string" ? { text: msg, response_type: "ephemeral" } : { ...msg, response_type: "ephemeral" });
    await handleCatchup(say, config);
  });

  app.command("/hier", async ({ ack, respond, command }: any) => {
    await ack();
    const config = loadConfig();
    if (command.user_id !== config.user.slackUserId) return;
    const say = (msg: string | Record<string, any>) =>
      respond(typeof msg === "string" ? { text: msg, response_type: "ephemeral" } : { ...msg, response_type: "ephemeral" });
    await handleDateContext(say, config, yesterdayStr());
  });

  app.command("/continue", async ({ ack, respond, command }: any) => {
    await ack();
    const config = loadConfig();
    if (command.user_id !== config.user.slackUserId) return;
    const say = (msg: string | Record<string, any>) =>
      respond(typeof msg === "string" ? { text: msg, response_type: "ephemeral" } : { ...msg, response_type: "ephemeral" });
    await handleContinue(say, config);
  });

  // ── DM: free text (ticket key, description, "oui") ──
  app.message(async ({ message, say }: any) => {
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;

    const config = loadConfig();
    const text = message.text.trim().toLowerCase();
    const rawText = message.text.trim();
    const userId = "user" in message ? message.user : undefined;
    if (!userId) return;
    if (userId !== config.user.slackUserId) return;

    if (text === "continue" || text === "continuer" || text === "oui") {
      await handleContinue(say, config);
    } else {
      await handleFreeText(say, config, rawText);
    }
  });

  // ── CONFIRM: single gate for all time logging ──
  app.action("confirm_log", async ({ ack, body, client }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    const userId = body.user.id;
    const conv = conversations.get(userId);

    if (!conv?.pendingEntries?.length) {
      await client.chat.postMessage({
        channel: userId,
        text: "Aucune action en attente.",
      });
      return;
    }

    try {
      const config = loadConfig();
      const logged = await executeConfirmedLog(userId, conv.pendingEntries, config);

      conv.pendingEntries = undefined;

      await client.chat.postMessage({
        channel: userId,
        text: `✅ Logge: ${logged}`,
      });

      // In week-by-week catchup mode: advance to next week
      if (conv.catchupWeeks?.length && conv.currentWeekIndex !== undefined) {
        conv.currentWeekIndex++;
        if (conv.currentWeekIndex < conv.catchupWeeks.length) {
          const sayViaClient = (msg: string | Record<string, any>) =>
            client.chat.postMessage({
              channel: userId,
              ...(typeof msg === "string" ? { text: msg } : msg),
            });
          await sendWeekPrompt(sayViaClient, config, userId);
        } else {
          conversations.delete(userId);
          await client.chat.postMessage({
            channel: userId,
            text: "Rattrapage termine ! 🎉",
          });
        }
      } else {
        conversations.delete(userId);
      }
    } catch (err) {
      await client.chat.postMessage({
        channel: userId,
        text: `Erreur lors du log: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ── CANCEL ──
  app.action("cancel_log", async ({ ack, body, client }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    const userId = body.user.id;
    const conv = conversations.get(userId);

    conv && (conv.pendingEntries = undefined);

    // In week-by-week catchup mode: skip to next week
    if (conv?.catchupWeeks?.length && conv.currentWeekIndex !== undefined) {
      const skippedWeek = conv.catchupWeeks[conv.currentWeekIndex];
      conv.currentWeekIndex++;

      await client.chat.postMessage({
        channel: userId,
        text: `Semaine du ${dayName(skippedWeek.monday)} passee.`,
      });

      if (conv.currentWeekIndex < conv.catchupWeeks.length) {
        const config = loadConfig();
        const sayViaClient = (msg: string | Record<string, any>) =>
          client.chat.postMessage({
            channel: userId,
            ...(typeof msg === "string" ? { text: msg } : msg),
          });
        await sendWeekPrompt(sayViaClient, config, userId);
      } else {
        conversations.delete(userId);
        await client.chat.postMessage({
          channel: userId,
          text: "Rattrapage termine.",
        });
      }
    } else {
      conversations.delete(userId);
      await client.chat.postMessage({
        channel: userId,
        text: "Annule.",
      });
    }
  });

  // ── SELECT suggested ticket → confirmation ──
  app.action(/^select_ticket_/, async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    if (action.type !== "button") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    if (!conv) return;

    const issueKey = action.value;
    if (!issueKey) return;

    const issue = await getIssue(issueKey);

    // In week-by-week catchup: apply to whole current week
    const week = conv.catchupWeeks?.[conv.currentWeekIndex ?? -1];
    const id = Number(issue.id);
    conv.pendingEntries = week
      ? week.days
          .filter((d) => d.remainingHours > 0)
          .map((d) => ({
            issueKey,
            issueId: id,
            summary: issue.fields.summary,
            hours: d.remainingHours,
            date: d.date,
          }))
      : [
          {
            issueKey,
            issueId: id,
            summary: issue.fields.summary,
            hours: conv.dayStatus.remainingHours,
            date: conv.dayStatus.date,
          },
        ];

    await client.chat.postMessage({
      channel: userId,
      ...confirmBlock(conv.pendingEntries),
    });
  });

  // ── CREATE ticket → confirmation ──
  app.action("create_ticket", async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    if (action.type !== "button") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    if (!conv) return;

    const summary = action.value || "Nouveau ticket";
    const config = loadConfig();

    try {
      const issue = await createIssue({
        project: config.user.workProject,
        summary,
      });

      await client.chat.postMessage({
        channel: userId,
        text: `Ticket cree: ${issue.key} - ${issue.fields.summary}`,
      });

      // In week-by-week catchup: apply to whole current week
      const week = conv.catchupWeeks?.[conv.currentWeekIndex ?? -1];
      const id = Number(issue.id);
      conv.pendingEntries = week
        ? week.days
            .filter((d) => d.remainingHours > 0)
            .map((d) => ({
              issueKey: issue.key,
              issueId: id,
              summary: issue.fields.summary,
              hours: d.remainingHours,
              date: d.date,
            }))
        : [
            {
              issueKey: issue.key,
              issueId: id,
              summary: issue.fields.summary,
              hours: conv.dayStatus.remainingHours,
              date: conv.dayStatus.date,
            },
          ];

      await client.chat.postMessage({
        channel: userId,
        ...confirmBlock(conv.pendingEntries),
      });
    } catch (err) {
      await client.chat.postMessage({
        channel: userId,
        text: `Erreur creation ticket: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });


  // ── CATCHUP: fill whole week with ticket ──
  app.action("catchup_week_all", async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    const week = conv?.catchupWeeks?.[conv.currentWeekIndex ?? -1];
    if (!conv || !week) return;

    const issueKey = action.value;
    const config = loadConfig();
    const issue = await getIssue(issueKey);
    const id = Number(issue.id);

    const entries: PendingEntry[] = week.days
      .filter((d) => d.remainingHours > 0)
      .map((d) => ({
        issueKey,
        issueId: id,
        summary: issue.fields.summary,
        hours: d.remainingHours,
        date: d.date,
      }));

    conv.pendingEntries = entries;
    await client.chat.postMessage({
      channel: userId,
      ...confirmBlock(entries),
    });
  });

  // ── CATCHUP: fill until a specific day ──
  app.action(/^catchup_until_/, async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    const week = conv?.catchupWeeks?.[conv.currentWeekIndex ?? -1];
    if (!conv || !week) return;

    const untilDate = (action.action_id as string).replace("catchup_until_", "");
    const issueKey = action.value;
    const config = loadConfig();
    const issue = await getIssue(issueKey);
    const id = Number(issue.id);

    const entries: PendingEntry[] = week.days
      .filter((d) => d.remainingHours > 0 && d.date <= untilDate)
      .map((d) => ({
        issueKey,
        issueId: id,
        summary: issue.fields.summary,
        hours: d.remainingHours,
        date: d.date,
      }));

    conv.pendingEntries = entries;
    await client.chat.postMessage({
      channel: userId,
      ...confirmBlock(entries),
    });
  });

  // ── CATCHUP: let Claude decide based on GitHub ──
  app.action("catchup_claude", async ({ ack, body, client }: any) => {
    await ack();
    if (body.type !== "block_actions") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    const week = conv?.catchupWeeks?.[conv.currentWeekIndex ?? -1];
    if (!conv || !week) return;

    const config = loadConfig();

    await client.chat.postMessage({
      channel: userId,
      text: "🤖 Analyse en cours...",
    });

    let analysis;
    try {
      analysis = await analyzeGitHubActivity(
        config.user.workProject,
        config.user.jiraAccountId,
        week.ghActivity.length > 0 ? week.ghActivity : conv.githubActivity || []
      );
    } catch {
      await client.chat.postMessage({
        channel: userId,
        text: "Erreur Claude. Envoie un numero de ticket directement.",
      });
      return;
    }

    const weekHours = week.days.reduce((s, d) => s + d.remainingHours, 0);
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *${analysis.understood}*`,
        },
      },
    ];

    for (const s of analysis.suggestions) {
      const conf = s.confidence === "high" ? "🟢" : s.confidence === "medium" ? "🟡" : "🔴";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${conf} *${s.issueKey}* — ${s.summary}\n_${s.reason}_`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: `Toute la semaine (${weekHours}h)` },
          action_id: `catchup_week_all`,
          value: s.issueKey,
        },
      });
    }

    if (analysis.shouldCreateNew && analysis.suggestedSummary) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Ou creer: _${analysis.suggestedSummary}_`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Creer" },
          action_id: "create_ticket",
          value: analysis.suggestedSummary,
          style: "primary",
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Ou envoie un numero de ticket / une description." }],
    });

    await client.chat.postMessage({
      channel: userId,
      blocks,
      text: "Suggestions Claude",
    });
  });
}

// ──────────────────────────────────────────────
// Message handlers
// ──────────────────────────────────────────────

async function handleStatus(say: SayFn, config: Config) {
  const today = todayStr();
  const status = await getDayStatus(config, today);
  const ticket = await getCurrentTicketForUser(config);

  let text = formatDayStatus(status);
  if (ticket) {
    text += `\nTicket en cours: *${ticket.key}* - ${ticket.fields.summary}`;
  }
  await say(text);
}

async function handleWeekStatus(say: SayFn, config: Config) {
  const week = await getWeekStatus(config, todayStr());
  await say(weekSummaryBlocks(week));
}

async function handleCatchup(say: SayFn, config: Config) {
  await say("Scan en cours...");

  const unfilled = await scanUnfilledDays(config, 12);

  if (unfilled.length === 0) {
    await say("Tout est rempli, rien a rattraper !");
    return;
  }

  const totalHours = unfilled.reduce((s, d) => s + d.remainingHours, 0);
  const from = unfilled[0].date;
  const to = unfilled[unfilled.length - 1].date;

  // Fetch GitHub activity for the whole period
  let ghActivity: GitHubActivity[] = [];
  if (config.user.githubUsername && config.user.githubOrg) {
    try {
      ghActivity = await getActivityForPeriod(
        config.user.githubUsername,
        config.user.githubOrg,
        from,
        to
      );
    } catch {}
  }

  // Group unfilled days into weeks
  const weeks = groupByWeek(unfilled, ghActivity);

  const userId = config.user.slackUserId;
  conversations.set(userId, {
    dayStatus: unfilled[0],
    catchupWeeks: weeks,
    currentWeekIndex: 0,
    githubActivity: ghActivity,
  });

  // Show overview then start first week
  await say(catchupOverview(unfilled, totalHours, weeks.length));
  await sendWeekPrompt(say, config, userId);
}

function groupByWeek(days: DayStatus[], ghActivity: GitHubActivity[]): CatchupWeek[] {
  const ghByDate = new Map<string, GitHubActivity>();
  for (const a of ghActivity) ghByDate.set(a.date, a);

  const weekMap = new Map<string, CatchupWeek>();
  for (const d of days) {
    const dt = new Date(d.date + "T12:00:00");
    const mon = new Date(dt);
    mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    const monStr = formatLocalDate(mon);

    if (!weekMap.has(monStr)) {
      weekMap.set(monStr, { monday: monStr, days: [], ghActivity: [] });
    }
    const week = weekMap.get(monStr)!;
    week.days.push(d);

    const gh = ghByDate.get(d.date);
    if (gh) week.ghActivity.push(gh);
  }

  return [...weekMap.values()].sort((a, b) => a.monday.localeCompare(b.monday));
}

function catchupOverview(unfilled: DayStatus[], totalHours: number, weekCount: number) {
  const lines = unfilled.map(
    (d) => `${statusEmoji(d)}  \`${dayName(d.date).padEnd(18)}\`  ${progressBar(d.loggedHours, d.targetHours)}  *${d.remainingHours}h*`
  );

  // Split into chunks of ~10 lines to stay under 3000 chars
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📋 Rattrapage — ${unfilled.length} jour(s), ${totalHours}h` },
    },
  ];

  for (let i = 0; i < lines.length; i += 10) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.slice(i, i + 10).join("\n") },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${weekCount} semaine(s) a parcourir. C'est parti !` }],
  });

  return { blocks, text: `Rattrapage: ${unfilled.length} jour(s)` };
}

async function sendWeekPrompt(say: SayFn, config: Config, userId: string) {
  const conv = conversations.get(userId);
  if (!conv?.catchupWeeks?.length || conv.currentWeekIndex === undefined) return;

  if (conv.currentWeekIndex >= conv.catchupWeeks.length) {
    await say("Rattrapage termine ! 🎉");
    conversations.delete(userId);
    return;
  }

  const week = conv.catchupWeeks[conv.currentWeekIndex];
  const ticket = await getCurrentTicketForUser(config);
  const weekHours = week.days.reduce((s, d) => s + d.remainingHours, 0);

  // Build week context
  const dayLines = week.days.map((d) => {
    const line = `${statusEmoji(d)}  \`${dayName(d.date).padEnd(18)}\`  *${d.remainingHours}h*`;
    return line;
  });

  // GitHub activity for this week
  const ghLines: string[] = [];
  for (const gh of week.ghActivity) {
    for (const c of gh.commits.slice(0, 3)) {
      const msg = c.message.length > 60 ? c.message.slice(0, 57) + "..." : c.message;
      ghLines.push(`💻 <${c.url}|\`${c.sha}\`> ${msg}`);
    }
    for (const pr of gh.prs.slice(0, 2)) {
      const title = pr.title.length > 60 ? pr.title.slice(0, 57) + "..." : pr.title;
      ghLines.push(`🔀 <${pr.url}|#${pr.number}> ${title}`);
    }
  }

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📅 Semaine du ${dayName(week.monday)} (${weekHours}h)` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: dayLines.join("\n") },
    },
  ];

  if (ghLines.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: ghLines.slice(0, 8).join("\n") }],
    });
  }

  if (ticket) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Ticket en cours: *${ticket.key}* — ${ticket.fields.summary}`,
      },
    });

    // Duration buttons: whole week, or up to specific day
    const durationButtons: any[] = [
      {
        type: "button",
        text: { type: "plain_text", text: `✅ Toute la semaine (${weekHours}h)` },
        action_id: "catchup_week_all",
        value: ticket.key,
        style: "primary",
      },
    ];

    // Individual day limit buttons (only if > 1 day)
    if (week.days.length > 1) {
      for (let i = 0; i < week.days.length - 1; i++) {
        const d = week.days[i];
        const hoursUpTo = week.days.slice(0, i + 1).reduce((s, dd) => s + dd.remainingHours, 0);
        durationButtons.push({
          type: "button",
          text: { type: "plain_text", text: `Jusqu'a ${dayName(d.date)} (${hoursUpTo}h)` },
          action_id: `catchup_until_${d.date}`,
          value: ticket.key,
        });
      }
    }

    blocks.push({
      type: "actions",
      elements: durationButtons.slice(0, 5),
    });
  }

  // "Autre chose" option
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "Autre ticket ? Decris ce que tu as fait ou envoie un numero de ticket." },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "🤖 Claude decide" },
      action_id: "catchup_claude",
      style: "primary",
    },
  });

  // Update conversation to target this week's first day
  conv.dayStatus = week.days[0];

  await say({ blocks, text: `Semaine du ${dayName(week.monday)}` });
}

async function handleDateContext(say: SayFn, config: Config, date: string) {
  const status = await getDayStatus(config, date);

  if (status.isWeekend || status.isHoliday || status.isAbsent) {
    await say(`${dayName(date)} — pas de temps a logger (${status.isHoliday ? "ferie" : status.isAbsent ? "absent" : "weekend"}).`);
    return;
  }

  if (status.remainingHours === 0) {
    await say(`${dayName(date)} — deja complet (${status.loggedHours}h).`);
    return;
  }

  const userId = config.user.slackUserId;
  conversations.set(userId, { dayStatus: status });

  const ticket = await getCurrentTicketForUser(config);
  let text = `*${dayName(date)}* — ${status.loggedHours}h/${status.targetHours}h (reste ${status.remainingHours}h).`;
  if (ticket) {
    text += `\nTicket en cours: *${ticket.key}* - ${ticket.fields.summary}`;
    text += `\nReponds *continue* ou decris ce que tu as fait.`;
  } else {
    text += `\nDecris ce que tu as fait.`;
  }
  await say(text);
}

async function handleContinue(say: SayFn, config: Config) {
  const userId = config.user.slackUserId;
  const conv = conversations.get(userId);

  // Use conversation date context if set, otherwise today
  const date = conv?.dayStatus?.date || todayStr();
  const status = conv?.dayStatus || await getDayStatus(config, date);

  if (status.remainingHours === 0) {
    await say("Journee deja complete, rien a logger.");
    return;
  }

  const ticket = await getCurrentTicketForUser(config);
  if (!ticket) {
    await say("Aucun ticket 'In Progress' trouve. Decris ce que tu as fait.");
    return;
  }

  const entries: PendingEntry[] = [
    {
      issueKey: ticket.key,
      issueId: Number(ticket.id),
      summary: ticket.fields.summary,
      hours: status.remainingHours,
      date: status.date,
    },
  ];

  if (!conv) {
    conversations.set(userId, { dayStatus: status, pendingEntries: entries });
  } else {
    conv.pendingEntries = entries;
  }

  await say(confirmBlock(entries));
}

async function handleFreeText(say: SayFn, config: Config, text: string) {
  const userId = config.user.slackUserId;
  const conv = conversations.get(userId);

  // Use conversation date context if set, otherwise today
  const date = conv?.dayStatus?.date || todayStr();
  const status = conv?.dayStatus || await getDayStatus(config, date);

  if (status.remainingHours === 0) {
    await say(`${dayName(date)} deja complete, rien a logger.`);
    return;
  }

  // ── Pattern: "Xh sur TICKET" (one or more) ──
  const splitPattern = /(\d+(?:[.,]\d+)?)\s*h\s+(?:sur|on)\s+([A-Z]+-\d+)/gi;
  const splitEntries: PendingEntry[] = [];
  let match;

  while ((match = splitPattern.exec(text)) !== null) {
    splitEntries.push({
      hours: parseFloat(match[1].replace(",", ".")),
      issueKey: match[2].toUpperCase(),
      issueId: 0,
      summary: "",
      date: status.date,
    });
  }

  if (splitEntries.length > 0) {
    const totalExplicit = splitEntries.reduce((s, e) => s + e.hours, 0);

    if (
      text.match(/le reste|the rest|reste/i) &&
      totalExplicit < status.remainingHours
    ) {
      const ticket = await getCurrentTicketForUser(config);
      if (ticket) {
        splitEntries.push({
          hours: status.remainingHours - totalExplicit,
          issueKey: ticket.key,
          issueId: Number(ticket.id),
          summary: ticket.fields.summary,
          date: status.date,
        });
      }
    }

    for (const entry of splitEntries) {
      if (!entry.summary || !entry.issueId) {
        try {
          const issue = await getIssue(entry.issueKey);
          entry.summary = entry.summary || issue.fields.summary;
          entry.issueId = Number(issue.id);
        } catch {
          entry.summary = entry.summary || entry.issueKey;
        }
      }
    }

    if (!conv) {
      conversations.set(userId, { dayStatus: status, pendingEntries: splitEntries });
    } else {
      conv.pendingEntries = splitEntries;
    }
    await say(confirmBlock(splitEntries));
    return;
  }

  // ── Direct ticket key ──
  const ticketMatch = text.match(/^([A-Z]+-\d+)$/i);
  if (ticketMatch) {
    const issueKey = ticketMatch[1].toUpperCase();
    try {
      const issue = await getIssue(issueKey);

      // In week-by-week catchup: apply to whole current week
      const week = conv?.catchupWeeks?.[conv.currentWeekIndex ?? -1];
      const id = Number(issue.id);
      const entries: PendingEntry[] = week
        ? week.days
            .filter((d) => d.remainingHours > 0)
            .map((d) => ({
              issueKey,
              issueId: id,
              summary: issue.fields.summary,
              hours: d.remainingHours,
              date: d.date,
            }))
        : [
            {
              issueKey,
              issueId: id,
              summary: issue.fields.summary,
              hours: status.remainingHours,
              date: status.date,
            },
          ];

      if (!conv) {
        conversations.set(userId, { dayStatus: status, pendingEntries: entries });
      } else {
        conv.pendingEntries = entries;
      }
      await say(confirmBlock(entries));
    } catch {
      await say(`Ticket ${issueKey} introuvable.`);
    }
    return;
  }

  // ── Free text → Claude ──
  await say("Analyse en cours...");

  const analysis = await analyzeWorkDescription(
    text,
    config.user.workProject,
    config.user.jiraAccountId
  );

  if (!conv) {
    conversations.set(userId, { dayStatus: status });
  }

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `J'ai compris: *${analysis.understood}*\n${status.remainingHours}h a logger pour le ${dayName(status.date)}.`,
      },
    },
  ];

  if (analysis.suggestions.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Tickets trouves:*" },
    });

    for (const s of analysis.suggestions) {
      const confidence =
        s.confidence === "high"
          ? "+++"
          : s.confidence === "medium"
            ? "++"
            : "+";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `[${confidence}] *${s.issueKey}* - ${s.summary}\n_${s.reason}_`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Choisir" },
          action_id: `select_ticket_${s.issueKey}`,
          value: s.issueKey,
        },
      });
    }
  }

  if (analysis.shouldCreateNew && analysis.suggestedSummary) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Ou creer un nouveau ticket: _${analysis.suggestedSummary}_`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Creer" },
        action_id: "create_ticket",
        value: analysis.suggestedSummary,
        style: "primary",
      },
    });
  }

  await say({ blocks, text: "Suggestions de tickets" });
}

// ──────────────────────────────────────────────
// Catchup prompt — shows unfilled days with actions
// ──────────────────────────────────────────────
function statusEmoji(d: DayStatus): string {
  if (d.isWeekend) return "⬜";
  if (d.isHoliday) return "🎉";
  if (d.isAbsent) return "🏖️";
  if (d.remainingHours === 0) return "✅";
  if (d.loggedHours > 0) return "🟡";
  return "❌";
}

function progressBar(logged: number, target: number): string {
  if (target === 0) return "";
  const filled = Math.round((logged / target) * 8);
  return "█".repeat(filled) + "░".repeat(8 - filled);
}



// ──────────────────────────────────────────────
// Confirmation block — shown before EVERY log
// ──────────────────────────────────────────────
function confirmBlock(entries: PendingEntry[]) {
  const totalHours = entries.reduce((s, e) => s + e.hours, 0);

  // Group by date
  const byDate = new Map<string, PendingEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.date) || [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const lines: string[] = [];
  for (const [date, dayEntries] of byDate) {
    if (byDate.size > 1) lines.push(`\n*${dayName(date)}:*`);
    for (const e of dayEntries) {
      lines.push(`▸ \`${e.hours}h\`  *${e.issueKey}* — ${e.summary}`);
    }
  }

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `⏱️ Confirmer — ${totalHours}h` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Confirmer" },
          action_id: "confirm_log",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Annuler" },
          action_id: "cancel_log",
          style: "danger",
        },
      ],
    },
  ];

  return { text: `Logger ${totalHours}h?`, blocks };
}

// ──────────────────────────────────────────────
// Week summary formatting
// ──────────────────────────────────────────────
function weekSummaryBlocks(week: DayStatus[]) {
  const workDays = week.filter((d) => !d.isWeekend);
  const totalLogged = workDays.reduce((s, d) => s + d.loggedHours, 0);
  const totalTarget = workDays.reduce((s, d) => s + d.targetHours, 0);
  const totalRemaining = workDays.reduce((s, d) => s + d.remainingHours, 0);

  const lines = workDays.map((d) => {
    let detail = "";
    if (d.isHoliday) detail = d.holidayName || "Ferie";
    else if (d.isAbsent) detail = d.absenceType || "Absent";
    else detail = `${progressBar(d.loggedHours, d.targetHours)}  ${d.loggedHours}h / ${d.targetHours}h`;

    return `${statusEmoji(d)}  \`${dayName(d.date).padEnd(18)}\`  ${detail}`;
  });

  const summaryText = totalRemaining > 0
    ? `*${totalLogged}h / ${totalTarget}h* — reste ${totalRemaining}h`
    : `*${totalLogged}h / ${totalTarget}h* — Semaine complete ! 🎉`;

  return {
    text: summaryText,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "📅 Semaine" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: summaryText }],
      },
    ],
  };
}

// ──────────────────────────────────────────────
// Daily reminder
// ──────────────────────────────────────────────
export async function sendReminder(config: Config) {
  const today = todayStr();
  const status = await getDayStatus(config, today);

  if (status.isWeekend || status.isHoliday || status.isAbsent) return;
  if (status.remainingHours === 0) return;

  const ticket = await getCurrentTicketForUser(config);
  let text = `Il reste *${status.remainingHours}h* a logger pour aujourd'hui (${dayName(today)}).`;

  if (ticket) {
    text += `\nTicket en cours: *${ticket.key}* - ${ticket.fields.summary}`;
    text += `\n\nReponds *continue* pour logger ${status.remainingHours}h dessus, ou decris ce que tu as fait.`;
  } else {
    text += `\nAucun ticket en cours. Decris ce que tu as fait.`;
  }

  await app.client.chat.postMessage({
    channel: config.user.slackUserId,
    text,
  });
}

// ──────────────────────────────────────────────
// Friday weekly summary
// ──────────────────────────────────────────────
export async function sendWeeklySummary(config: Config) {
  const week = await getWeekStatus(config, todayStr());
  const { blocks, text } = weekSummaryBlocks(week);

  const unfilled = week.filter(
    (d) => !d.isWeekend && !d.isHoliday && !d.isAbsent && d.remainingHours > 0
  );

  if (unfilled.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Reponds *rattrapage* pour completer les ${unfilled.length} jour(s) manquant(s).`,
      },
    });
  }

  await app.client.chat.postMessage({
    channel: config.user.slackUserId,
    text,
    blocks,
  });
}

type SayFn = (message: string | Record<string, any>) => Promise<any>;
