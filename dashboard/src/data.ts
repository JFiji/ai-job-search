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
