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
  issueKey: string;
  accountId: string;
  date: string;
  seconds: number;
  description?: string;
}): Promise<TempoWorklog> {
  const body = {
    issueKey: params.issueKey,
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

export async function deleteWorklog(worklogId: number): Promise<void> {
  const res = await fetch(`${TEMPO_BASE}/worklogs/${worklogId}`, {
    method: "DELETE",
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Tempo delete worklog error ${res.status}: ${await res.text()}`);
  }
}
