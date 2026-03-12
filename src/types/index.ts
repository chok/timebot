export interface UserConfig {
  jiraAccountId: string;
  slackUserId: string;
  country: "FR" | "QC" | "ES";
  workProject: string;
  adminProject: string;
  weeklyHours: number;
  dailyHours: number;
  reminderTime: string;
  timezone: string;
  githubUsername: string;
  githubOrg: string;
}

export interface GitHubActivity {
  date: string;
  commits: GitHubCommit[];
  prs: GitHubPR[];
}

export interface GitHubCommit {
  sha: string;
  message: string;
  repo: string;
  url: string;
  date: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: string;
  date: string;
}

export interface Config {
  user: UserConfig;
}

export interface TempoWorklog {
  tempoWorklogId: number;
  issue: {
    self: string;
    id: number;
    key?: string;
  };
  timeSpentSeconds: number;
  startDate: string;
  startTime: string;
  description: string;
  author: {
    accountId: string;
  };
}

export interface TempoWorklogResponse {
  self: string;
  metadata: {
    count: number;
    offset: number;
    limit: number;
    next?: string;
  };
  results: TempoWorklog[];
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
      statusCategory: {
        key: string;
      };
    };
    assignee?: {
      accountId: string;
      displayName: string;
    } | null;
    issuetype: {
      name: string;
    };
    project: {
      key: string;
    };
  };
}

export interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

export interface FolksAbsence {
  id: string;
  startDate: string;
  endDate: string;
  type: string;
  status: string;
  employeeId: string;
}

export interface DayStatus {
  date: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isAbsent: boolean;
  absenceType?: string;
  loggedHours: number;
  targetHours: number;
  remainingHours: number;
}
