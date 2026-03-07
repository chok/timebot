import type { GitHubActivity, GitHubCommit, GitHubPR } from "../types/index.js";

const GITHUB_API = "https://api.github.com";

function getToken(): string | null {
  return process.env.GITHUB_TOKEN || null;
}

function headers(): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function getCommits(
  username: string,
  org: string,
  from: string,
  to: string
): Promise<GitHubCommit[]> {
  if (!getToken()) return [];

  // GitHub Search API: commits by author in date range
  const q = `author:${username} org:${org} committer-date:${from}..${to}`;
  const res = await fetch(
    `${GITHUB_API}/search/commits?q=${encodeURIComponent(q)}&sort=committer-date&per_page=100`,
    { headers: headers() }
  );

  if (!res.ok) {
    console.warn(`GitHub commits API error ${res.status}: ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  return (data.items || []).map((item: any) => ({
    sha: item.sha?.slice(0, 7) || "",
    message: item.commit?.message?.split("\n")[0] || "",
    repo: item.repository?.full_name || "",
    url: item.html_url || "",
    date: item.commit?.committer?.date?.slice(0, 10) || "",
  }));
}

export async function getPRs(
  username: string,
  org: string,
  from: string,
  to: string
): Promise<GitHubPR[]> {
  if (!getToken()) return [];

  const q = `type:pr author:${username} org:${org} created:${from}..${to}`;
  const res = await fetch(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&per_page=100`,
    { headers: headers() }
  );

  if (!res.ok) {
    console.warn(`GitHub PRs API error ${res.status}: ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  return (data.items || []).map((item: any) => {
    // Extract repo from url: https://api.github.com/repos/org/repo/...
    const repoMatch = item.repository_url?.match(/repos\/(.+)$/);
    return {
      number: item.number,
      title: item.title || "",
      repo: repoMatch?.[1] || "",
      url: item.html_url || "",
      state: item.state || "",
      date: item.created_at?.slice(0, 10) || "",
    };
  });
}

export async function getActivityForPeriod(
  username: string,
  org: string,
  from: string,
  to: string
): Promise<GitHubActivity[]> {
  const [commits, prs] = await Promise.all([
    getCommits(username, org, from, to),
    getPRs(username, org, from, to),
  ]);

  // Group by date
  const byDate = new Map<string, GitHubActivity>();

  for (const c of commits) {
    if (!byDate.has(c.date)) {
      byDate.set(c.date, { date: c.date, commits: [], prs: [] });
    }
    byDate.get(c.date)!.commits.push(c);
  }

  for (const pr of prs) {
    if (!byDate.has(pr.date)) {
      byDate.set(pr.date, { date: pr.date, commits: [], prs: [] });
    }
    byDate.get(pr.date)!.prs.push(pr);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
