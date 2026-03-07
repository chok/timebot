import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../config/index.js";
import { searchTickets, getMyActiveTickets } from "./jira.js";
import type { JiraIssue, GitHubActivity } from "../types/index.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });
  }
  return client;
}

export interface TicketSuggestion {
  issueKey: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ClaudeAnalysis {
  understood: string;
  suggestions: TicketSuggestion[];
  shouldCreateNew: boolean;
  suggestedSummary?: string;
}

export async function analyzeWorkDescription(
  description: string,
  project: string,
  accountId: string,
  githubActivity?: GitHubActivity[]
): Promise<ClaudeAnalysis> {
  const [activeTickets, searchResults] = await Promise.all([
    getMyActiveTickets(accountId, project),
    searchTickets(description, project).catch(() => [] as JiraIssue[]),
  ]);

  const allTickets = deduplicateTickets([...activeTickets, ...searchResults]);

  const ticketList = allTickets
    .map(
      (t) =>
        `- ${t.key}: "${t.fields.summary}" (status: ${t.fields.status.name})`
    )
    .join("\n");

  let githubContext = "";
  if (githubActivity?.length) {
    const lines: string[] = [];
    for (const day of githubActivity) {
      for (const c of day.commits) {
        lines.push(`- Commit ${c.sha} (${c.date}, ${c.repo}): ${c.message}`);
      }
      for (const pr of day.prs) {
        lines.push(`- PR #${pr.number} (${pr.date}, ${pr.repo}): ${pr.title}`);
      }
    }
    githubContext = `\nActivite GitHub sur la periode:\n${lines.join("\n")}`;
  }

  const message = await getClient().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `Tu es un assistant qui aide a matcher des descriptions de travail avec des tickets Jira.
Tu reponds UNIQUEMENT en JSON valide, sans markdown ni commentaires.
Format attendu:
{
  "understood": "reformulation courte de ce que l'utilisateur a fait",
  "suggestions": [
    {"issueKey": "CYB-123", "summary": "...", "confidence": "high|medium|low", "reason": "..."}
  ],
  "shouldCreateNew": false,
  "suggestedSummary": "titre si creation necessaire"
}
- Utilise l'activite GitHub (commits, PRs) pour deviner sur quel ticket l'utilisateur a travaille.
- Les messages de commit et titres de PR contiennent souvent des references a des tickets (ex: CYB-123).
- Si un ticket correspond bien, mets-le en "high".
- Si aucun ticket ne correspond, mets shouldCreateNew a true avec un suggestedSummary.
- Maximum 3 suggestions.`,
    messages: [
      {
        role: "user",
        content: `Description du travail: "${description}"

Tickets disponibles dans le projet ${project}:
${ticketList || "(aucun ticket trouve)"}
${githubContext}
Analyse et propose les meilleurs matches.`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  try {
    return JSON.parse(text);
  } catch {
    return {
      understood: description,
      suggestions: [],
      shouldCreateNew: true,
      suggestedSummary: description,
    };
  }
}

// Analyze GitHub activity for a period and suggest tickets without user description
export async function analyzeGitHubActivity(
  project: string,
  accountId: string,
  githubActivity: GitHubActivity[]
): Promise<ClaudeAnalysis> {
  if (!githubActivity.length) {
    return {
      understood: "Aucune activite GitHub trouvee",
      suggestions: [],
      shouldCreateNew: false,
    };
  }

  const activityDesc = githubActivity
    .flatMap((day) => [
      ...day.commits.map((c) => `Commit (${c.date}): ${c.message}`),
      ...day.prs.map((pr) => `PR (${pr.date}): ${pr.title}`),
    ])
    .join("; ");

  return analyzeWorkDescription(activityDesc, project, accountId, githubActivity);
}

function deduplicateTickets(tickets: JiraIssue[]): JiraIssue[] {
  const seen = new Set<string>();
  return tickets.filter((t) => {
    if (seen.has(t.key)) return false;
    seen.add(t.key);
    return true;
  });
}
