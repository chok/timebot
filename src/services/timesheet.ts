import { getWorklogsForDate, totalLoggedHours, getLastLoggedIssueId } from "../integrations/tempo.js";
import { getCurrentTicket, getIssue } from "../integrations/jira.js";
import { isAbsent } from "../integrations/folks.js";
import { isHoliday } from "./holidays.js";
import type { Config, DayStatus, JiraIssue } from "../types/index.js";

function isWeekend(date: string): boolean {
  const d = new Date(date + "T12:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getDayStatus(config: Config, date: string): Promise<DayStatus> {
  const { user } = config;

  if (isWeekend(date)) {
    return {
      date,
      isWeekend: true,
      isHoliday: false,
      isAbsent: false,
      loggedHours: 0,
      targetHours: 0,
      remainingHours: 0,
    };
  }

  const holidayCheck = isHoliday(user.country, date);
  if (holidayCheck.holiday) {
    return {
      date,
      isWeekend: false,
      isHoliday: true,
      holidayName: holidayCheck.name,
      isAbsent: false,
      loggedHours: 0,
      targetHours: 0,
      remainingHours: 0,
    };
  }

  let absentCheck = { absent: false, type: undefined as string | undefined };
  try {
    absentCheck = await isAbsent(date);
  } catch {
    // Folks unavailable, continue without absence data
  }

  if (absentCheck.absent) {
    return {
      date,
      isWeekend: false,
      isHoliday: false,
      isAbsent: true,
      absenceType: absentCheck.type,
      loggedHours: 0,
      targetHours: 0,
      remainingHours: 0,
    };
  }

  const worklogs = await getWorklogsForDate(user.jiraAccountId, date);
  const logged = totalLoggedHours(worklogs);
  const remaining = Math.max(0, user.dailyHours - logged);

  return {
    date,
    isWeekend: false,
    isHoliday: false,
    isAbsent: false,
    loggedHours: logged,
    targetHours: user.dailyHours,
    remainingHours: remaining,
  };
}

export async function getWeekStatus(
  config: Config,
  weekStart: string
): Promise<DayStatus[]> {
  const start = new Date(weekStart + "T12:00:00");
  // Adjust to Monday if needed
  const day = start.getDay();
  const monday = new Date(start);
  monday.setDate(start.getDate() - ((day + 6) % 7));

  const days: DayStatus[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = formatLocalDate(d);
    days.push(await getDayStatus(config, dateStr));
  }

  return days;
}

export function formatDayStatus(status: DayStatus): string {
  if (status.isWeekend) return `${status.date} — Weekend`;
  if (status.isHoliday) return `${status.date} — Ferie (${status.holidayName})`;
  if (status.isAbsent) return `${status.date} — Absent (${status.absenceType})`;
  if (status.remainingHours === 0)
    return `${status.date} — Complet (${status.loggedHours}h)`;
  return `${status.date} — ${status.loggedHours}h/${status.targetHours}h (reste ${status.remainingHours}h)`;
}

export async function getCurrentTicketForUser(
  config: Config
): Promise<JiraIssue | null> {
  // Priority 1: last ticket logged in Tempo (last 7 days)
  try {
    const issueId = await getLastLoggedIssueId(config.user.jiraAccountId);
    if (issueId) {
      return await getIssue(String(issueId));
    }
  } catch {
    // Tempo unavailable, fall through
  }

  // Priority 2: Jira "In Progress" ticket
  return getCurrentTicket(config.user.jiraAccountId, config.user.workProject);
}

// Smart scan:
// 1. Check Wednesday of each week going back until we find one fully logged (= the boundary)
// 2. Deep scan every workday from boundary to yesterday
export async function scanUnfilledDays(
  config: Config,
  maxWeeks: number = 12
): Promise<DayStatus[]> {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayStr = formatLocalDate(today);

  // Step 1: Find the boundary — scan Wednesdays backwards
  let boundaryMonday: Date | null = null;

  for (let w = 1; w <= maxWeeks; w++) {
    const ref = new Date(today);
    ref.setDate(today.getDate() - w * 7);
    const dow = ref.getDay();
    const monday = new Date(ref);
    monday.setDate(ref.getDate() - ((dow + 6) % 7));

    const wed = new Date(monday);
    wed.setDate(monday.getDate() + 2);
    const wedStr = formatLocalDate(wed);

    if (wedStr >= todayStr) continue;

    const wedStatus = await getDayStatus(config, wedStr);

    // Wednesday is a normal workday and fully logged → this week is the boundary
    if (
      !wedStatus.isWeekend &&
      !wedStatus.isHoliday &&
      !wedStatus.isAbsent &&
      wedStatus.remainingHours === 0
    ) {
      // Boundary = the Monday after this filled week
      boundaryMonday = new Date(monday);
      boundaryMonday.setDate(monday.getDate() + 7);
      break;
    }
  }

  // If no filled week found, start from maxWeeks ago
  if (!boundaryMonday) {
    boundaryMonday = new Date(today);
    boundaryMonday.setDate(today.getDate() - maxWeeks * 7);
    const dow = boundaryMonday.getDay();
    boundaryMonday.setDate(boundaryMonday.getDate() - ((dow + 6) % 7));
  }

  // Step 2: Deep scan every workday from boundary to yesterday
  const unfilled: DayStatus[] = [];
  const cursor = new Date(boundaryMonday);
  cursor.setHours(12, 0, 0, 0);

  while (formatLocalDate(cursor) < todayStr) {
    const dateStr = formatLocalDate(cursor);
    const status = await getDayStatus(config, dateStr);

    if (
      !status.isWeekend &&
      !status.isHoliday &&
      !status.isAbsent &&
      status.remainingHours > 0
    ) {
      unfilled.push(status);
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return unfilled;
}
