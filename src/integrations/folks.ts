import type { FolksAbsence } from "../types/index.js";

const FOLKS_BASE = "https://api.folkshr.app/api";

function getApiKey(): string | null {
  return process.env.FOLKS_API_KEY || null;
}

export async function getAbsences(
  from: string,
  to: string
): Promise<FolksAbsence[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const res = await fetch(
    `${FOLKS_BASE}/absences?startDate=${from}&endDate=${to}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    console.warn(
      `Folks API error ${res.status}: ${await res.text()}. Absences won't be considered.`
    );
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : data.data ?? [];
}

export async function isAbsent(date: string): Promise<{ absent: boolean; type: string | undefined }> {
  const absences = await getAbsences(date, date);
  if (absences.length === 0) return { absent: false, type: undefined };
  return { absent: true, type: absences[0].type };
}
