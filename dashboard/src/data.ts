import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TrackerRow {
  date: string;
  company: string;
  sector: string;
  role: string;
  role_type: string;
  channel: string;
  status: string;
  contact_person: string;
  fit_rating: string;
  notes: string;
  cv_file: string;
  cover_letter_file: string;
  source: string;
}

export const STATUS_BUCKETS = [
  "Drafted",
  "Active",
  "Interview",
  "Offer",
  "Hired",
  "Rejected/Closed",
] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

export interface NormalizedRow extends TrackerRow {
  bucket: StatusBucket;
  outcomeStages?: string[];
}

const BUCKET_MAP: Record<string, StatusBucket> = {
  drafted: "Drafted",
  applied: "Active",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected/Closed",
  no_response: "Rejected/Closed",
  "no response": "Rejected/Closed",
  offer_declined: "Rejected/Closed",
  "offer declined": "Rejected/Closed",
  withdrawn: "Rejected/Closed",
};

export function normalizeStatus(raw: string): { bucket: StatusBucket; unrecognized: boolean } {
  const key = raw.trim().toLowerCase();
  const bucket = BUCKET_MAP[key];
  if (bucket) return { bucket, unrecognized: false };
  return { bucket: "Rejected/Closed", unrecognized: true };
}

const TRACKER_COLUMNS: (keyof TrackerRow)[] = [
  "date", "company", "sector", "role", "role_type", "channel", "status",
  "contact_person", "fit_rating", "notes", "cv_file", "cover_letter_file", "source",
];

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"') { inQuotes = true; i++; continue; }
    if (char === ',') { pushField(); i++; continue; }
    if (char === '\r') { i++; continue; }
    if (char === '\n') { pushRow(); i++; continue; }
    field += char; i++;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface TrackerParseResult {
  rows: TrackerRow[];
  malformedCount: number;
}

export function parseTrackerCsv(text: string): TrackerParseResult {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], malformedCount: 0 };
  const header = table[0];
  const rows: TrackerRow[] = [];
  let malformedCount = 0;
  for (const line of table.slice(1)) {
    if (line.length !== header.length) { malformedCount++; continue; }
    const record: Partial<TrackerRow> = {};
    for (let i = 0; i < TRACKER_COLUMNS.length; i++) {
      record[TRACKER_COLUMNS[i]] = line[i] ?? "";
    }
    rows.push(record as TrackerRow);
  }
  return { rows, malformedCount };
}

export interface FunnelCounts {
  applied: number;
  interview: number;
  offer: number;
  hired: number;
}

export interface Stats {
  total: number;
  draftedCount: number;
  byBucket: Record<StatusBucket, number>;
  bySector: Record<string, number>;
  byChannel: Record<string, number>;
  byYear: Record<string, number>;
  funnel: FunnelCounts;
  funnelRate: number;
  rejectionRate: number;
  unrecognizedStatuses: string[];
}

function extractYear(date: string): string {
  const m = date.match(/(\d{4})/);
  return m ? m[1] : "Unknown";
}

export function computeStats(rows: NormalizedRow[]): Stats {
  const byBucket = Object.fromEntries(STATUS_BUCKETS.map((b) => [b, 0])) as Record<StatusBucket, number>;
  const bySector: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  const unrecognizedStatuses = new Set<string>();

  for (const row of rows) {
    byBucket[row.bucket]++;
    if (normalizeStatus(row.status).unrecognized) unrecognizedStatuses.add(row.status.trim());
  }

  const submitted = rows.filter((r) => r.bucket !== "Drafted");
  for (const row of submitted) {
    if (row.sector) bySector[row.sector] = (bySector[row.sector] ?? 0) + 1;
    if (row.channel) byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1;
    const year = extractYear(row.date);
    byYear[year] = (byYear[year] ?? 0) + 1;
  }

  const funnel: FunnelCounts = {
    applied: submitted.length,
    interview: byBucket.Interview + byBucket.Offer + byBucket.Hired,
    offer: byBucket.Offer + byBucket.Hired,
    hired: byBucket.Hired,
  };
  const funnelRate = funnel.applied > 0 ? (funnel.interview / funnel.applied) * 100 : 0;

  const resolved = submitted.length - byBucket.Active;
  const rejectionRate = resolved > 0 ? (byBucket["Rejected/Closed"] / resolved) * 100 : 0;

  return {
    total: submitted.length,
    draftedCount: byBucket.Drafted,
    byBucket,
    bySector,
    byChannel,
    byYear,
    funnel,
    funnelRate,
    rejectionRate,
    unrecognizedStatuses: [...unrecognizedStatuses],
  };
}

export function fuzzyKey(company: string, role: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  return `${clean(company)}::${clean(role)}`;
}

export interface OutcomeInfo {
  company: string;
  role: string;
  stagesReached: string[];
}

export function parseOutcomeMd(text: string): OutcomeInfo | null {
  const headerMatch = text.match(/^#\s*Outcome:\s*(.+?)\s*—\s*(.+)$/m);
  if (!headerMatch) return null;
  const stagesReached: string[] = [];
  const stageLineRe = /^-\s*\[x\]\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = stageLineRe.exec(text)) !== null) {
    stagesReached.push(m[1].trim());
  }
  return { company: headerMatch[1].trim(), role: headerMatch[2].trim(), stagesReached };
}

export interface DashboardData {
  rows: NormalizedRow[];
  stats: Stats;
  generatedAt: string;
  warning?: string;
}

export async function loadDashboardData(repoRoot: string): Promise<DashboardData> {
  let csvText: string;
  try {
    csvText = await readFile(join(repoRoot, "job_search_tracker.csv"), "utf-8");
  } catch {
    return {
      rows: [],
      stats: computeStats([]),
      generatedAt: new Date().toISOString(),
      warning: "job_search_tracker.csv not found or unreadable",
    };
  }

  const { rows: trackerRows, malformedCount } = parseTrackerCsv(csvText);
  const warnings: string[] = [];
  if (malformedCount > 0) warnings.push(`${malformedCount} row(s) skipped: wrong column count`);

  const outcomesByKey = new Map<string, OutcomeInfo>();
  try {
    const appsDir = join(repoRoot, "documents", "applications");
    const entries = await readdir(appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const outcomeText = await readFile(join(appsDir, entry.name, "outcome.md"), "utf-8");
        const outcome = parseOutcomeMd(outcomeText);
        if (outcome) outcomesByKey.set(fuzzyKey(outcome.company, outcome.role), outcome);
      } catch {
        // no outcome.md for this application yet - nothing to merge
      }
    }
  } catch {
    // documents/applications missing entirely - the dashboard still works from the CSV alone
  }

  const rows: NormalizedRow[] = trackerRows.map((row) => {
    const { bucket } = normalizeStatus(row.status);
    const outcome = outcomesByKey.get(fuzzyKey(row.company, row.role));
    return { ...row, bucket, outcomeStages: outcome?.stagesReached };
  });

  return {
    rows,
    stats: computeStats(rows),
    generatedAt: new Date().toISOString(),
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}
