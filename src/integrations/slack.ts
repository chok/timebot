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
  summary: string;
  hours: number;
  date: string;
}

interface ConversationState {
  dayStatus: DayStatus;
  pendingEntries?: PendingEntry[];
  catchupDates?: string[];
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
      issueKey: entry.issueKey,
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
  app.message(async ({ message, say }: any) => {
    if (message.subtype) return;
    if (!("text" in message) || !message.text) return;

    const config = loadConfig();
    const text = message.text.trim().toLowerCase();
    const rawText = message.text.trim();
    const userId = "user" in message ? message.user : undefined;
    if (!userId) return;
    if (userId !== config.user.slackUserId) return;

    if (text === "status" || text === "statut") {
      await handleStatus(say, config);
    } else if (text === "semaine" || text === "week") {
      await handleWeekStatus(say, config);
    } else if (text === "rattrapage" || text === "catchup") {
      await handleCatchup(say, config);
    } else if (text === "hier" || text === "yesterday") {
      await handleDateContext(say, config, yesterdayStr());
    } else if (
      text === "continue" ||
      text === "continuer" ||
      text === "oui"
    ) {
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
      const date = conv.pendingEntries[0].date;
      const catchupDates = conv.catchupDates;

      // Clear pending but keep catchup context
      conv.pendingEntries = undefined;

      await client.chat.postMessage({
        channel: userId,
        text: `Logge: ${logged} (${date}).`,
      });

      // If in catchup mode, move to next unfilled day
      if (catchupDates?.length) {
        const remaining = catchupDates.filter((d) => d !== date);
        if (remaining.length > 0) {
          conversations.delete(userId);
          await sendCatchupPrompt(client, userId, remaining, config);
        } else {
          conversations.delete(userId);
          await client.chat.postMessage({
            channel: userId,
            text: "Semaine complete !",
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
    const catchupDates = conv?.catchupDates;
    const currentDate = conv?.dayStatus?.date;

    conv && (conv.pendingEntries = undefined);

    // In catchup mode, skip this day and move to next
    if (catchupDates?.length) {
      const remaining = catchupDates.filter((d) => d !== currentDate);
      conversations.delete(userId);

      if (remaining.length > 0) {
        const config = loadConfig();
        await client.chat.postMessage({
          channel: userId,
          text: `${dayName(currentDate!)} passe.`,
        });
        await sendCatchupPrompt(client, userId, remaining, config);
      } else {
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

    conv.pendingEntries = [
      {
        issueKey,
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

      conv.pendingEntries = [
        {
          issueKey: issue.key,
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

  // ── FILL a specific catchup day ──
  app.action(/^fillday_/, async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    if (action.type !== "button") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    if (!conv) return;

    const date = action.value;
    if (!date) return;

    const config = loadConfig();
    const status = await getDayStatus(config, date);
    const ticket = await getCurrentTicketForUser(config);

    // Update conversation to target this date
    conv.dayStatus = status;

    if (ticket) {
      await client.chat.postMessage({
        channel: userId,
        text: `*${dayName(date)}* — ${status.remainingHours}h a logger.\nTicket en cours: *${ticket.key}* - ${ticket.fields.summary}\n\nReponds *continue* pour logger dessus, ou decris ce que tu as fait ce jour-la.`,
      });
    } else {
      await client.chat.postMessage({
        channel: userId,
        text: `*${dayName(date)}* — ${status.remainingHours}h a logger.\nDecris ce que tu as fait ce jour-la.`,
      });
    }
  });

  // ── FILL ALL remaining days with current ticket ──
  app.action("fillall_current", async ({ ack, body, client }: any) => {
    await ack();
    if (body.type !== "block_actions") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    if (!conv?.catchupDates?.length) return;

    const config = loadConfig();
    const ticket = await getCurrentTicketForUser(config);
    if (!ticket) {
      await client.chat.postMessage({
        channel: userId,
        text: "Aucun ticket 'In Progress' trouve.",
      });
      return;
    }

    // Build entries for all unfilled days
    const entries: PendingEntry[] = [];
    for (const date of conv.catchupDates) {
      const status = await getDayStatus(config, date);
      if (status.remainingHours > 0) {
        entries.push({
          issueKey: ticket.key,
          summary: ticket.fields.summary,
          hours: status.remainingHours,
          date,
        });
      }
    }

    if (entries.length === 0) {
      conversations.delete(userId);
      await client.chat.postMessage({
        channel: userId,
        text: "Rien a remplir.",
      });
      return;
    }

    conv.pendingEntries = entries;
    await client.chat.postMessage({
      channel: userId,
      ...confirmBlock(entries),
    });
  });

  // ── FILL ALL with a specific suggested ticket ──
  app.action(/^fillall_ticket_/, async ({ ack, body, client, action }: any) => {
    await ack();
    if (body.type !== "block_actions") return;
    if (action.type !== "button") return;

    const userId = body.user.id;
    const conv = conversations.get(userId);
    if (!conv?.catchupDates?.length) return;

    const issueKey = action.value;
    if (!issueKey) return;

    const config = loadConfig();
    const issue = await getIssue(issueKey);

    const entries: PendingEntry[] = [];
    for (const date of conv.catchupDates) {
      const status = await getDayStatus(config, date);
      if (status.remainingHours > 0) {
        entries.push({
          issueKey,
          summary: issue.fields.summary,
          hours: status.remainingHours,
          date,
        });
      }
    }

    if (entries.length === 0) {
      conversations.delete(userId);
      await client.chat.postMessage({
        channel: userId,
        text: "Rien a remplir.",
      });
      return;
    }

    conv.pendingEntries = entries;
    await client.chat.postMessage({
      channel: userId,
      ...confirmBlock(entries),
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

  // Fetch GitHub activity for the period
  let ghActivity: GitHubActivity[] = [];
  if (config.user.githubUsername && config.user.githubOrg) {
    try {
      ghActivity = await getActivityForPeriod(
        config.user.githubUsername,
        config.user.githubOrg,
        from,
        to
      );
    } catch {
      // GitHub unavailable, continue without
    }
  }

  const userId = config.user.slackUserId;
  conversations.set(userId, {
    dayStatus: unfilled[0],
    catchupDates: unfilled.map((d) => d.date),
    githubActivity: ghActivity,
  });

  // If we have GitHub activity, ask Claude for suggestions
  let analysis: Awaited<ReturnType<typeof analyzeGitHubActivity>> | null = null;
  if (ghActivity.length > 0) {
    try {
      analysis = await analyzeGitHubActivity(
        config.user.workProject,
        config.user.jiraAccountId,
        ghActivity
      );
    } catch {
      // Claude unavailable, continue without suggestions
    }
  }

  await say(catchupBlock(unfilled, config, totalHours, ghActivity, analysis));
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
          summary: ticket.fields.summary,
          date: status.date,
        });
      }
    }

    for (const entry of splitEntries) {
      if (!entry.summary) {
        try {
          const issue = await getIssue(entry.issueKey);
          entry.summary = issue.fields.summary;
        } catch {
          entry.summary = entry.issueKey;
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
      const entries: PendingEntry[] = [
        {
          issueKey,
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

function catchupBlock(
  unfilled: DayStatus[],
  _config: Config,
  totalHours?: number,
  ghActivity?: GitHubActivity[],
  analysis?: { understood: string; suggestions: { issueKey: string; summary: string; confidence: string; reason: string }[]; shouldCreateNew: boolean; suggestedSummary?: string } | null
) {
  const total = totalHours ?? unfilled.reduce((s, d) => s + d.remainingHours, 0);

  // Group unfilled by week
  const byWeek = new Map<string, DayStatus[]>();
  for (const d of unfilled) {
    const dt = new Date(d.date + "T12:00:00");
    const mon = new Date(dt);
    mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    const weekKey = formatLocalDate(mon);
    const list = byWeek.get(weekKey) || [];
    list.push(d);
    byWeek.set(weekKey, list);
  }

  // Index GitHub activity by date
  const ghByDate = new Map<string, GitHubActivity>();
  if (ghActivity) {
    for (const a of ghActivity) ghByDate.set(a.date, a);
  }

  const dayButtons = unfilled.map((d) => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text: dayName(d.date) },
    action_id: `fillday_${d.date}`,
    value: d.date,
  }));

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📋 Rattrapage — ${unfilled.length} jour(s)` },
    },
  ];

  // Per-week sections with GitHub activity inline
  for (const [weekMon, days] of byWeek) {
    const weekHours = days.reduce((s, d) => s + d.remainingHours, 0);
    const lines: string[] = [];

    for (const d of days) {
      lines.push(
        `${statusEmoji(d)}  \`${dayName(d.date).padEnd(18)}\`  ${progressBar(d.loggedHours, d.targetHours)}  *${d.remainingHours}h*`
      );

      // Show GitHub activity for this day
      const dayGh = ghByDate.get(d.date);
      if (dayGh) {
        for (const c of dayGh.commits) {
          lines.push(`      💻 <${c.url}|\`${c.sha}\`> ${c.message}  _${c.repo}_`);
        }
        for (const pr of dayGh.prs) {
          lines.push(`      🔀 <${pr.url}|#${pr.number}> ${pr.title}  _${pr.repo}_`);
        }
      }
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Semaine du ${dayName(weekMon)}* — ${weekHours}h a remplir\n${lines.join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `*Total: ${total}h sur ${unfilled.length} jour(s)*` }],
  });

  // Claude suggestions based on GitHub activity
  if (analysis?.suggestions?.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🤖 *Suggestions (basees sur GitHub):*\n_${analysis.understood}_`,
      },
    });

    for (const s of analysis.suggestions) {
      const conf = s.confidence === "high" ? "🟢" : s.confidence === "medium" ? "🟡" : "🔴";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${conf} *${s.issueKey}* — ${s.summary}\n      _${s.reason}_`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Tout sur ce ticket" },
          action_id: `fillall_ticket_${s.issueKey}`,
          value: s.issueKey,
        },
      });
    }
  }

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Remplir jour par jour:*" },
  });

  for (let i = 0; i < dayButtons.length; i += 5) {
    blocks.push({
      type: "actions",
      elements: dayButtons.slice(i, i + 5),
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: `⚡ Tout remplir (${total}h)` },
        action_id: "fillall_current",
        style: "primary",
      },
    ],
  });

  return { blocks, text: `Rattrapage: ${unfilled.length} jour(s), ${total}h` };
}

async function sendCatchupPrompt(
  client: any,
  userId: string,
  dates: string[],
  config: Config
) {
  const statuses: DayStatus[] = [];
  for (const date of dates) {
    const s = await getDayStatus(config, date);
    if (s.remainingHours > 0) statuses.push(s);
  }

  if (statuses.length === 0) {
    await client.chat.postMessage({
      channel: userId,
      text: "Tout est rempli !",
    });
    return;
  }

  conversations.set(userId, {
    dayStatus: statuses[0],
    catchupDates: statuses.map((s) => s.date),
  });

  await client.chat.postMessage({
    channel: userId,
    ...catchupBlock(statuses, config),
  });
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
