import { getEnv } from "../config/index.js";
import type { JiraIssue, JiraSearchResponse } from "../types/index.js";

function baseUrl() {
  return getEnv("ATLASSIAN_BASE_URL");
}

function headers() {
  const email = getEnv("ATLASSIAN_EMAIL");
  const token = getEnv("ATLASSIAN_API_TOKEN");
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function jiraSearch(jql: string, maxResults = 20): Promise<JiraSearchResponse> {
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: "summary,status,assignee,issuetype,project",
  });
  const res = await fetch(`${baseUrl()}/rest/api/3/search/jql?${params}`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Jira search error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export async function getCurrentTicket(
  accountId: string,
  project: string
): Promise<JiraIssue | null> {
  const jql = `project = "${project}" AND assignee = "${accountId}" AND statusCategory = "In Progress" ORDER BY updated DESC`;
  const result = await jiraSearch(jql, 1);
  return result.issues[0] || null;
}

export async function getMyActiveTickets(
  accountId: string,
  project: string,
  maxResults = 10
): Promise<JiraIssue[]> {
  const jql = `project = "${project}" AND assignee = "${accountId}" AND status != "Done" ORDER BY updated DESC`;
  return (await jiraSearch(jql, maxResults)).issues;
}

export async function searchTickets(
  query: string,
  project: string
): Promise<JiraIssue[]> {
  const jql = `project = "${project}" AND text ~ "${query}" ORDER BY updated DESC`;
  return (await jiraSearch(jql, 10)).issues;
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const res = await fetch(
    `${baseUrl()}/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,issuetype,project`,
    { headers: headers() }
  );

  if (!res.ok) {
    throw new Error(`Jira get issue error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export async function createIssue(params: {
  project: string;
  summary: string;
  issueType?: string;
}): Promise<JiraIssue> {
  const body = {
    fields: {
      project: { key: params.project },
      summary: params.summary,
      issuetype: { name: params.issueType || "Task" },
    },
  };

  const res = await fetch(`${baseUrl()}/rest/api/3/issue`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Jira create issue error ${res.status}: ${await res.text()}`);
  }

  const created = await res.json();
  return getIssue(created.key);
}

export async function getMyself(): Promise<{ accountId: string; displayName: string; emailAddress: string }> {
  const res = await fetch(`${baseUrl()}/rest/api/3/myself`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Jira myself error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}
