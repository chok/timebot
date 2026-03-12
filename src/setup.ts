import { createInterface } from "readline";
import { writeFileSync, chmodSync } from "fs";
import { stringify } from "yaml";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function testJiraConnection(
  baseUrl: string,
  email: string,
  token: string
): Promise<{ accountId: string; displayName: string } | null> {
  try {
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { accountId: data.accountId, displayName: data.displayName };
  } catch {
    return null;
  }
}

async function testTempoConnection(token: string, accountId: string): Promise<boolean> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.tempo.io/4/worklogs/user/${accountId}?from=${today}&to=${today}&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function testSlackConnection(botToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\n=== Timebot Setup ===\n");
  console.log("This will configure your Timebot instance.\n");

  // --- Atlassian / Jira ---
  console.log("--- Jira / Atlassian ---");
  console.log("Create an API token at: https://id.atlassian.com/manage-profile/security/api-tokens\n");

  const atlassianBaseUrl = await ask("Atlassian base URL (https://xxx.atlassian.net)");
  const atlassianEmail = await ask("Atlassian email");
  const atlassianToken = await askSecret("Atlassian API token");

  console.log("\nTesting Jira connection...");
  const jiraUser = await testJiraConnection(atlassianBaseUrl, atlassianEmail, atlassianToken);
  if (!jiraUser) {
    console.error("Failed to connect to Jira. Check your credentials.");
    rl.close();
    process.exit(1);
  }
  console.log(`Connected as: ${jiraUser.displayName} (${jiraUser.accountId})\n`);

  // --- Tempo ---
  console.log("--- Tempo ---");
  console.log("Create a Tempo API token at: Settings > API Integration in Tempo\n");

  const tempoToken = await askSecret("Tempo API token");

  console.log("Testing Tempo connection...");
  const tempoOk = await testTempoConnection(tempoToken, jiraUser.accountId);
  if (!tempoOk) {
    console.warn("Warning: Could not verify Tempo connection. Continuing anyway.\n");
  } else {
    console.log("Tempo connection OK.\n");
  }

  // --- Slack ---
  console.log("--- Slack ---");
  console.log("Create a Slack app at: https://api.slack.com/apps");
  console.log("Enable Socket Mode. Add Bot Token Scopes: chat:write, im:read, im:write, im:history");
  console.log("Install to your workspace.\n");

  const slackBotToken = await askSecret("Slack Bot Token (xoxb-...)");
  const slackAppToken = await askSecret("Slack App Token (xapp-...)");

  if (slackBotToken) {
    console.log("Testing Slack connection...");
    const slackOk = await testSlackConnection(slackBotToken);
    if (!slackOk) {
      console.warn("Warning: Could not verify Slack connection. Continuing anyway.\n");
    } else {
      console.log("Slack connection OK.\n");
    }
  }

  const slackUserId = await ask("Your Slack User ID (find in profile > ⋮ > Copy member ID)");

  // --- Folks ---
  console.log("\n--- Folks HR ---");
  console.log("API key from: Admin > Company > API Key Management in Folks");
  console.log("(Leave empty to skip — absences won't be checked)\n");

  const folksApiKey = await askSecret("Folks API key (or empty to skip)");

  // --- Claude ---
  console.log("\n--- Claude (Anthropic) ---");
  console.log("API key from: https://console.anthropic.com/settings/keys\n");

  const anthropicKey = await askSecret("Anthropic API key (sk-ant-...)");

  // --- GitHub ---
  console.log("\n--- GitHub ---");
  console.log("Personal access token from: https://github.com/settings/tokens");
  console.log("Scopes needed: repo (read)\n");

  const githubToken = await askSecret("GitHub token (ghp_... or empty to skip)");
  const githubUsername = await ask("GitHub username");
  const githubOrg = await ask("GitHub org (for commit/PR search)");

  // --- User config ---
  console.log("\n--- Configuration ---");
  const country = await ask("Country for holidays (FR/QC/ES)", "FR");
  const workProject = await ask("Jira project for work tickets", "CYB");
  const adminProject = await ask("Jira project for admin/absence", "ADM");
  const dailyHours = await ask("Default daily hours", "7");
  const weeklyHours = await ask("Weekly target hours", "35");
  const reminderTime = await ask("Daily reminder time (HH:MM)", "17:00");
  const timezone = await ask("Timezone", "Europe/Paris");

  // --- Write .env ---
  const envContent = [
    `ATLASSIAN_BASE_URL=${atlassianBaseUrl}`,
    `ATLASSIAN_EMAIL=${atlassianEmail}`,
    `ATLASSIAN_API_TOKEN=${atlassianToken}`,
    `TEMPO_API_TOKEN=${tempoToken}`,
    `SLACK_BOT_TOKEN=${slackBotToken}`,
    `SLACK_APP_TOKEN=${slackAppToken}`,
    folksApiKey ? `FOLKS_API_KEY=${folksApiKey}` : "# FOLKS_API_KEY=",
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    githubToken ? `GITHUB_TOKEN=${githubToken}` : "# GITHUB_TOKEN=",
  ].join("\n");

  writeFileSync(".env", envContent + "\n");
  chmodSync(".env", 0o600);
  console.log("\n.env written (permissions: 600)");

  // --- Write config.yaml ---
  const config = {
    user: {
      jiraAccountId: jiraUser.accountId,
      slackUserId,
      country: country.toUpperCase(),
      workProject: workProject.toUpperCase(),
      adminProject: adminProject.toUpperCase(),
      weeklyHours: parseInt(weeklyHours),
      dailyHours: parseInt(dailyHours),
      reminderTime,
      timezone,
      githubUsername: githubUsername || "",
      githubOrg: githubOrg || "",
    },
  };

  writeFileSync("config.yaml", stringify(config));
  chmodSync("config.yaml", 0o600);
  console.log("config.yaml written (permissions: 600)");

  console.log("\nSetup complete! Run `bun start` to launch Timebot.\n");
  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
