import { getEnv } from "../config/index.js";
import type { TempoWorklog, TempoWorklogResponse } from "../types/index.js";

const TEMPO_BASE = "https://api.tempo.io/4";

function headers() {
  return {
    Authorization: `Bearer ${getEnv("TEMPO_API_TOKEN")}`,
    "Content-Type": "application/json",
  };
}

export async function getWorklogs(
  accountId: string,
  from: string,
  to: string
): Promise<TempoWorklog[]> {
  const all: TempoWorklog[] = [];
  let url: string | null =
    `${TEMPO_BASE}/worklogs/user/${accountId}?from=${from}&to=${to}&limit=50`;

  while (url) {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      throw new Error(`Tempo API error ${res.status}: ${await res.text()}`);
    }
    const data: TempoWorklogResponse = await res.json();
    all.push(...data.results);
    url = data.metadata.next || null;
  }

  return all;
}

export async function getWorklogsForDate(
  accountId: string,
  date: string
): Promise<TempoWorklog[]> {
  return getWorklogs(accountId, date, date);
}

export function totalLoggedHours(worklogs: TempoWorklog[]): number {
  const seconds = worklogs.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
  return seconds / 3600;
}

export async function createWorklog(params: {
  issueId: number;
  accountId: string;
  date: string;
  seconds: number;
  description?: string;
}): Promise<TempoWorklog> {
  const body = {
    issueId: params.issueId,
    timeSpentSeconds: params.seconds,
    startDate: params.date,
    startTime: "09:00:00",
    description: params.description || "",
    authorAccountId: params.accountId,
  };

  const res = await fetch(`${TEMPO_BASE}/worklogs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Tempo create worklog error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export async function getLastLoggedIssueId(
  accountId: string
): Promise<number | null> {
  // Look at last 7 days of worklogs
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const worklogs = await getWorklogs(accountId, fmt(from), fmt(to));
  if (worklogs.length === 0) return null;

  // Sort by tempoWorklogId DESC — the highest ID is the most recently CREATED worklog
  worklogs.sort((a, b) => b.tempoWorklogId - a.tempoWorklogId);

  return worklogs[0].issue.id;
}

export async function deleteWorklog(worklogId: number): Promise<void> {
  const res = await fetch(`${TEMPO_BASE}/worklogs/${worklogId}`, {
    method: "DELETE",
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Tempo delete worklog error ${res.status}: ${await res.text()}`);
  }
}
