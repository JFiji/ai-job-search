# Job Application Dashboard GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `/html-report` command with a local Bun-served dashboard that reads `job_search_tracker.csv` and `documents/applications/` live, and add an apply-trigger form that runs `/apply` headlessly (URL or pasted job spec) with progress streamed to the browser.

**Architecture:** A new `dashboard/` package (Bun + TypeScript) with a `GET /api/data` endpoint serving parsed/normalized tracker data as JSON, a client-rendered vanilla-JS/SVG UI (no build step, no framework), and a `POST /api/apply` + SSE pair that shells out to `claude -p "/apply <input>"` as a subprocess.

**Tech Stack:** Bun (server + test runner), TypeScript (`tsc --noEmit` for typechecking, no compiled output — Bun runs `.ts` directly), plain ES module JavaScript for the browser client, no runtime dependencies beyond the Bun/TypeScript toolchain.

**Spec:** `docs/superpowers/specs/2026-08-20-job-application-gui-design.md`

## Global Constraints

- Package lives at `dashboard/`, mirroring the `.agents/skills/*/cli/package.json` convention already used in this repo: `"scripts": { "test": "bun test", "typecheck": "tsc --noEmit" }`, zero/minimal runtime dependencies.
- No client build step — `dashboard/public/*.js` are plain ES modules served as-is and run directly in the browser; no bundler, no framework.
- Subprocess invocation for `/apply` MUST use array-form arguments (`Bun.spawn([...])`), never shell string concatenation — the input can be a pasted job description (untrusted external text) and must never be interpretable as shell syntax.
- Default server port `4173`, overridable via `PORT` env var or a CLI arg.
- Apply-run timeout: 15 minutes, after which the subprocess is killed and an `error` event is emitted.
- One apply job at a time — a second `POST /api/apply` while one is running returns `409`.
- Manual refresh only — the server never watches files; data is re-read fresh on every `GET /api/data` call, and the client only calls it on load and on the Refresh button.
- Status bucket colors (must match exactly, used in both stat cards and charts): Drafted `#64748b`, Active `#3b82f6`, Interview `#f59e0b`, Offer `#8b5cf6`, Hired `#22c55e`, Rejected/Closed `#ef4444`.
- Tracker CSV columns, fixed order: `date, company, sector, role, role_type, channel, status, contact_person, fit_rating, notes, cv_file, cover_letter_file, source`.
- Command files under `.claude/commands/*.md` must start with `# /<name>` — enforced by `tools/lint_skills.py`, which CI runs.

---

### Task 1: CSV parsing foundation

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/src/data.ts`
- Create: `dashboard/tests/data.test.ts`

**Interfaces:**
- Produces: `interface TrackerRow { date, company, sector, role, role_type, channel, status, contact_person, fit_rating, notes, cv_file, cover_letter_file, source: string }`, `interface TrackerParseResult { rows: TrackerRow[]; malformedCount: number }`, `parseCsv(text: string): string[][]`, `parseTrackerCsv(text: string): TrackerParseResult`

- [ ] **Step 1: Scaffold the package**

Create `dashboard/package.json`:

```json
{
  "name": "job-search-dashboard",
  "version": "1.0.0",
  "description": "Local Bun-served dashboard for job_search_tracker.csv, replacing /html-report, with an apply-trigger form that runs /apply headlessly.",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "1.3.14"
  }
}
```

Create `dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "allowJs": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "public/**/*.js"]
}
```

Run:
```bash
cd dashboard && bun install
```
This creates `bun.lock` and `node_modules/` (the latter is already covered by the repo's top-level `node_modules/` gitignore rule).

- [ ] **Step 2: Write the failing tests**

Create `dashboard/tests/data.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseCsv, parseTrackerCsv } from "../src/data";

describe("parseCsv", () => {
  test("splits simple comma-separated rows", () => {
    const result = parseCsv("a,b,c\n1,2,3\n");
    expect(result).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  test("handles quoted fields with embedded commas", () => {
    const result = parseCsv('date,notes\n2026-01-01,"Hybrid, 3 days a week"\n');
    expect(result).toEqual([
      ["date", "notes"],
      ["2026-01-01", "Hybrid, 3 days a week"],
    ]);
  });

  test("handles escaped double quotes inside a quoted field", () => {
    const result = parseCsv('note\n"She said ""hello"""\n');
    expect(result).toEqual([["note"], ['She said "hello"']]);
  });
});

describe("parseTrackerCsv", () => {
  const header =
    "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n";

  test("parses a well-formed row into a TrackerRow", () => {
    const csv =
      header +
      "2026-01-01,Acme,Tech,Engineer,Full-time,portal,applied,,80,Good fit,cv/a.tex,cover_letters/a.tex,https://example.com\n";
    const { rows, malformedCount } = parseTrackerCsv(csv);
    expect(malformedCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: "2026-01-01",
      company: "Acme",
      sector: "Tech",
      role: "Engineer",
      role_type: "Full-time",
      channel: "portal",
      status: "applied",
      contact_person: "",
      fit_rating: "80",
      notes: "Good fit",
      cv_file: "cv/a.tex",
      cover_letter_file: "cover_letters/a.tex",
      source: "https://example.com",
    });
  });

  test("skips and counts rows with the wrong column count", () => {
    const csv = header + "2026-01-01,Acme,Tech\n";
    const { rows, malformedCount } = parseTrackerCsv(csv);
    expect(rows).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  test("returns no rows for an empty file", () => {
    const { rows, malformedCount } = parseTrackerCsv("");
    expect(rows).toEqual([]);
    expect(malformedCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: FAIL — `src/data.ts` does not exist / exports not found.

- [ ] **Step 4: Implement `parseCsv` and `parseTrackerCsv`**

Create `dashboard/src/data.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Typecheck**

Run: `cd dashboard && bun run typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add dashboard/package.json dashboard/tsconfig.json dashboard/src/data.ts dashboard/tests/data.test.ts dashboard/bun.lock
git commit -m "dashboard: scaffold package and add tracker CSV parsing"
```

---

### Task 2: Status normalization

**Files:**
- Modify: `dashboard/src/data.ts`
- Modify: `dashboard/tests/data.test.ts`

**Interfaces:**
- Consumes: `TrackerRow` (Task 1)
- Produces: `STATUS_BUCKETS: readonly string[]`, `type StatusBucket`, `interface NormalizedRow extends TrackerRow { bucket: StatusBucket; outcomeStages?: string[] }`, `normalizeStatus(raw: string): { bucket: StatusBucket; unrecognized: boolean }`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/data.test.ts`:

```typescript
import { normalizeStatus } from "../src/data";

describe("normalizeStatus", () => {
  test("maps canonical statuses to their buckets", () => {
    expect(normalizeStatus("drafted")).toEqual({ bucket: "Drafted", unrecognized: false });
    expect(normalizeStatus("applied")).toEqual({ bucket: "Active", unrecognized: false });
    expect(normalizeStatus("interview")).toEqual({ bucket: "Interview", unrecognized: false });
    expect(normalizeStatus("offer")).toEqual({ bucket: "Offer", unrecognized: false });
    expect(normalizeStatus("hired")).toEqual({ bucket: "Hired", unrecognized: false });
  });

  test("maps rejection synonyms, including legacy space spellings, to Rejected/Closed", () => {
    for (const value of ["rejected", "no_response", "no response", "offer_declined", "offer declined", "withdrawn"]) {
      expect(normalizeStatus(value)).toEqual({ bucket: "Rejected/Closed", unrecognized: false });
    }
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(normalizeStatus("  Applied  ")).toEqual({ bucket: "Active", unrecognized: false });
  });

  test("buckets unrecognized values into Rejected/Closed and flags them", () => {
    expect(normalizeStatus("ghosted")).toEqual({ bucket: "Rejected/Closed", unrecognized: true });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: FAIL — `normalizeStatus` is not exported.

- [ ] **Step 3: Implement status normalization**

Add to `dashboard/src/data.ts` (after the `TrackerRow` interface):

```typescript
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && bun run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/data.ts dashboard/tests/data.test.ts
git commit -m "dashboard: add status bucket normalization"
```

---

### Task 3: Stats computation

**Files:**
- Modify: `dashboard/src/data.ts`
- Modify: `dashboard/tests/data.test.ts`

**Interfaces:**
- Consumes: `StatusBucket`, `STATUS_BUCKETS`, `NormalizedRow`, `normalizeStatus` (Task 2)
- Produces: `interface FunnelCounts { applied, interview, offer, hired: number }`, `interface Stats { total, draftedCount: number; byBucket: Record<StatusBucket, number>; bySector, byChannel, byYear: Record<string, number>; funnel: FunnelCounts; funnelRate, rejectionRate: number; unrecognizedStatuses: string[] }`, `computeStats(rows: NormalizedRow[]): Stats`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/data.test.ts`:

```typescript
import { computeStats, type NormalizedRow } from "../src/data";

function row(overrides: Partial<NormalizedRow>): NormalizedRow {
  return {
    date: "2026-01-01", company: "Acme", sector: "Tech", role: "Engineer",
    role_type: "Full-time", channel: "portal", status: "applied",
    contact_person: "", fit_rating: "80", notes: "", cv_file: "", cover_letter_file: "",
    source: "", bucket: "Active",
    ...overrides,
  };
}

describe("computeStats", () => {
  test("excludes Drafted rows from every stat except draftedCount and byBucket", () => {
    const rows = [row({ bucket: "Drafted", status: "drafted" }), row({ bucket: "Active", status: "applied" })];
    const stats = computeStats(rows);
    expect(stats.total).toBe(1);
    expect(stats.draftedCount).toBe(1);
    expect(stats.byBucket.Drafted).toBe(1);
    expect(stats.byBucket.Active).toBe(1);
  });

  test("computes sector, channel, and year breakdowns from submitted rows only", () => {
    const rows = [
      row({ bucket: "Drafted", status: "drafted", sector: "Should not count" }),
      row({ bucket: "Active", status: "applied", sector: "Tech", channel: "portal", date: "2026-03-15" }),
      row({ bucket: "Interview", status: "interview", sector: "Finance", channel: "referral", date: "2025" }),
    ];
    const stats = computeStats(rows);
    expect(stats.bySector).toEqual({ Tech: 1, Finance: 1 });
    expect(stats.byChannel).toEqual({ portal: 1, referral: 1 });
    expect(stats.byYear).toEqual({ "2026": 1, "2025": 1 });
  });

  test("computes cumulative funnel counts and funnel rate", () => {
    const rows = [
      row({ bucket: "Active", status: "applied" }),
      row({ bucket: "Interview", status: "interview" }),
      row({ bucket: "Offer", status: "offer" }),
      row({ bucket: "Hired", status: "hired" }),
    ];
    const stats = computeStats(rows);
    expect(stats.funnel).toEqual({ applied: 4, interview: 3, offer: 2, hired: 1 });
    expect(stats.funnelRate).toBeCloseTo(75); // 3 of 4 reached interview+
  });

  test("computes rejection rate over resolved applications, excluding Active", () => {
    const rows = [
      row({ bucket: "Active", status: "applied" }), // resolved: no
      row({ bucket: "Interview", status: "interview" }), // resolved: yes
      row({ bucket: "Rejected/Closed", status: "rejected" }), // resolved: yes
    ];
    const stats = computeStats(rows);
    // resolved = 2 (Interview + Rejected/Closed), 1 of those is Rejected/Closed
    expect(stats.rejectionRate).toBeCloseTo(50);
  });

  test("returns zero rates and empty breakdowns for no rows", () => {
    const stats = computeStats([]);
    expect(stats.total).toBe(0);
    expect(stats.funnelRate).toBe(0);
    expect(stats.rejectionRate).toBe(0);
  });

  test("names unrecognized statuses once each", () => {
    const rows = [
      row({ bucket: "Rejected/Closed", status: "ghosted" }),
      row({ bucket: "Rejected/Closed", status: "ghosted" }),
    ];
    const stats = computeStats(rows);
    expect(stats.unrecognizedStatuses).toEqual(["ghosted"]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: FAIL — `computeStats` is not exported.

- [ ] **Step 3: Implement `computeStats`**

Add to `dashboard/src/data.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && bun run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/data.ts dashboard/tests/data.test.ts
git commit -m "dashboard: add summary stats computation"
```

---

### Task 4: Outcome.md parsing and fuzzy matching

**Files:**
- Modify: `dashboard/src/data.ts`
- Modify: `dashboard/tests/data.test.ts`

**Interfaces:**
- Produces: `fuzzyKey(company: string, role: string): string`, `interface OutcomeInfo { company: string; role: string; stagesReached: string[] }`, `parseOutcomeMd(text: string): OutcomeInfo | null`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/data.test.ts`:

```typescript
import { fuzzyKey, parseOutcomeMd } from "../src/data";

describe("fuzzyKey", () => {
  test("is case-insensitive and ignores punctuation", () => {
    expect(fuzzyKey("Acme, Inc.", "Senior Engineer!")).toBe(fuzzyKey("acme inc", "senior engineer"));
  });

  test("collapses repeated whitespace", () => {
    expect(fuzzyKey("Acme   Corp", "Engineer")).toBe(fuzzyKey("Acme Corp", "Engineer"));
  });
});

describe("parseOutcomeMd", () => {
  const sample = `# Outcome: Acme Corp — Senior Engineer

**Status:** rejected

**Date resolved:** 2026-02-01

## Interview stages reached
- [x] Phone screen (2026-01-10)
- [x] Technical interview
- [ ] Case interview
- [ ] Final round
- [ ] Offer received

## Notes
Good conversation, went with an internal candidate.
`;

  test("extracts company and role from the header", () => {
    const outcome = parseOutcomeMd(sample);
    expect(outcome?.company).toBe("Acme Corp");
    expect(outcome?.role).toBe("Senior Engineer");
  });

  test("extracts only the checked interview stages", () => {
    const outcome = parseOutcomeMd(sample);
    expect(outcome?.stagesReached).toEqual(["Phone screen (2026-01-10)", "Technical interview"]);
  });

  test("returns null when the file has no recognizable header", () => {
    expect(parseOutcomeMd("not an outcome file")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: FAIL — `fuzzyKey`/`parseOutcomeMd` not exported.

- [ ] **Step 3: Implement `fuzzyKey` and `parseOutcomeMd`**

Add to `dashboard/src/data.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/data.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && bun run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/data.ts dashboard/tests/data.test.ts
git commit -m "dashboard: add outcome.md parsing and fuzzy company+role matching"
```

---

### Task 5: `loadDashboardData` orchestration

**Files:**
- Modify: `dashboard/src/data.ts`
- Create: `dashboard/tests/load-dashboard-data.test.ts`

**Interfaces:**
- Consumes: `parseTrackerCsv`, `normalizeStatus`, `computeStats`, `fuzzyKey`, `parseOutcomeMd`, `NormalizedRow`, `Stats` (Tasks 1-4)
- Produces: `interface DashboardData { rows: NormalizedRow[]; stats: Stats; generatedAt: string; warning?: string }`, `loadDashboardData(repoRoot: string): Promise<DashboardData>`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/load-dashboard-data.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDashboardData } from "../src/data";

const HEADER =
  "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n";

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), "dashboard-data-test-"));
}

describe("loadDashboardData", () => {
  test("parses the CSV and merges a matching outcome.md by fuzzy company+role", async () => {
    const dir = makeFixture();
    writeFileSync(
      join(dir, "job_search_tracker.csv"),
      HEADER +
        "2026-01-01,Acme Corp,Tech,Senior Engineer,Full-time,portal,rejected,,80,,,,https://example.com\n",
    );
    const appDir = join(dir, "documents", "applications", "acme_corp_senior_engineer");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "outcome.md"),
      "# Outcome: Acme Corp — Senior Engineer\n\n**Status:** rejected\n\n## Interview stages reached\n- [x] Phone screen\n\n## Notes\nn/a\n",
    );

    const data = await loadDashboardData(dir);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].bucket).toBe("Rejected/Closed");
    expect(data.rows[0].outcomeStages).toEqual(["Phone screen"]);
    expect(data.stats.total).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty dataset with a warning when the CSV is missing", async () => {
    const dir = makeFixture();
    const data = await loadDashboardData(dir);
    expect(data.rows).toEqual([]);
    expect(data.warning).toContain("job_search_tracker.csv");
    rmSync(dir, { recursive: true, force: true });
  });

  test("surfaces malformed rows as a warning instead of throwing", async () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "job_search_tracker.csv"), HEADER + "2026-01-01,Acme\n");
    const data = await loadDashboardData(dir);
    expect(data.rows).toHaveLength(0);
    expect(data.warning).toContain("1 row(s) skipped");
    rmSync(dir, { recursive: true, force: true });
  });

  test("works when documents/applications does not exist at all", async () => {
    const dir = makeFixture();
    writeFileSync(
      join(dir, "job_search_tracker.csv"),
      HEADER + "2026-01-01,Acme,Tech,Engineer,Full-time,portal,applied,,80,,,,\n",
    );
    const data = await loadDashboardData(dir);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].outcomeStages).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/load-dashboard-data.test.ts`
Expected: FAIL — `loadDashboardData` is not exported.

- [ ] **Step 3: Implement `loadDashboardData`**

Add to the top of `dashboard/src/data.ts` (imports) and the bottom (function):

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
```

```typescript
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/load-dashboard-data.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full data test suite and typecheck**

Run: `cd dashboard && bun test tests/data.test.ts tests/load-dashboard-data.test.ts && bun run typecheck`
Expected: all PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/data.ts dashboard/tests/load-dashboard-data.test.ts
git commit -m "dashboard: wire CSV parsing, status normalization, and outcome merging into loadDashboardData"
```

---

### Task 6: Apply job manager

**Files:**
- Create: `dashboard/src/apply.ts`
- Create: `dashboard/tests/apply.test.ts`

**Interfaces:**
- Produces: `type JobId = string`, `interface ApplyEvent { type: "message" | "done" | "error"; data: string }`, `type SpawnFn = (cmd: string[]) => { stdout: ReadableStream<Uint8Array> | null; stderr: ReadableStream<Uint8Array> | null; exited: Promise<number>; kill: () => void }`, `buildApplyCommand(input: string): string[]`, `class ApplyJobManager { constructor(spawnFn?: SpawnFn, timeoutMs?: number); start(input: string): { jobId: JobId } | { error: string; jobId?: JobId }; subscribe(jobId: JobId, listener: (event: ApplyEvent) => void): (() => void) | null; isRunning(): boolean }`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/apply.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ApplyJobManager, buildApplyCommand, type SpawnFn } from "../src/apply";

function fakeStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
}

describe("buildApplyCommand", () => {
  test("returns array-form arguments, never a shell string", () => {
    const cmd = buildApplyCommand("https://example.com/job posting with spaces");
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd).toEqual(["claude", "-p", "/apply https://example.com/job posting with spaces"]);
  });
});

describe("ApplyJobManager", () => {
  test("streams stdout lines and emits done on exit code 0", async () => {
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream(["evaluating fit", "drafting CV"]),
      stderr: fakeStream([]),
      exited,
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const result = manager.start("https://example.com/job");
    expect("jobId" in result).toBe(true);
    const jobId = (result as { jobId: string }).jobId;

    const events: { type: string; data: string }[] = [];
    const done = new Promise<void>((resolveDone) => {
      manager.subscribe(jobId, (event) => {
        events.push(event);
        if (event.type !== "message") resolveDone();
      });
    });
    resolveExited(0);
    await done;

    expect(events.some((e) => e.data === "evaluating fit")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("emits error when the process exits non-zero", async () => {
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: Promise.resolve(1),
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const { jobId } = manager.start("https://example.com/job") as { jobId: string };
    const event = await new Promise<{ type: string; data: string }>((resolve) => {
      manager.subscribe(jobId, (e) => { if (e.type !== "message") resolve(e); });
    });
    expect(event.type).toBe("error");
  });

  test("rejects a second concurrent apply with an error, not a crash", () => {
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: new Promise(() => {}),
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const first = manager.start("https://example.com/job-a");
    const second = manager.start("https://example.com/job-b");
    expect("jobId" in first).toBe(true);
    expect("error" in second).toBe(true);
    expect(manager.isRunning()).toBe(true);
  });

  test("kills the process and emits a timeout error after the timeout elapses", async () => {
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: new Promise(() => {}),
      kill: () => { killed = true; },
    });
    const manager = new ApplyJobManager(spawnFn, 20);
    const { jobId } = manager.start("https://example.com/job") as { jobId: string };
    const event = await new Promise<{ type: string; data: string }>((resolve) => {
      manager.subscribe(jobId, (e) => { if (e.type !== "message") resolve(e); });
    });
    expect(event.type).toBe("error");
    expect(event.data.toLowerCase()).toContain("timed out");
    expect(killed).toBe(true);
  });

  test("subscribe returns null for an unknown job id", () => {
    const manager = new ApplyJobManager();
    expect(manager.subscribe("no-such-job", () => {})).toBeNull();
  });

  test("returns an error instead of throwing when spawning fails synchronously (e.g. claude CLI missing)", () => {
    const spawnFn: SpawnFn = () => { throw new Error("spawn claude ENOENT"); };
    const manager = new ApplyJobManager(spawnFn, 1000);
    const result = manager.start("https://example.com/job");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("ENOENT");
    expect(manager.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/apply.test.ts`
Expected: FAIL — `dashboard/src/apply.ts` does not exist.

- [ ] **Step 3: Implement `apply.ts`**

Create `dashboard/src/apply.ts`:

```typescript
export type JobId = string;

export interface ApplyEvent {
  type: "message" | "done" | "error";
  data: string;
}

export type SpawnFn = (cmd: string[]) => {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function buildApplyCommand(input: string): string[] {
  return ["claude", "-p", `/apply ${input}`];
}

function defaultSpawn(cmd: string[]): ReturnType<SpawnFn> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
}

interface RunningJob {
  id: JobId;
  proc: ReturnType<SpawnFn>;
  listeners: Set<(event: ApplyEvent) => void>;
  timeoutHandle: ReturnType<typeof setTimeout>;
  finished: boolean;
}

export class ApplyJobManager {
  private current: RunningJob | null = null;

  constructor(
    private readonly spawnFn: SpawnFn = defaultSpawn,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  start(input: string): { jobId: JobId } | { error: string; jobId?: JobId } {
    if (this.current && !this.current.finished) {
      return { error: "An apply run is already in progress", jobId: this.current.id };
    }
    const id = crypto.randomUUID();
    let proc: ReturnType<SpawnFn>;
    try {
      proc = this.spawnFn(buildApplyCommand(input));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const job: RunningJob = {
      id,
      proc,
      listeners: new Set(),
      finished: false,
      timeoutHandle: setTimeout(() => this.timeoutJob(job), this.timeoutMs),
    };
    this.current = job;
    void this.pump(job);
    return { jobId: id };
  }

  subscribe(jobId: JobId, listener: (event: ApplyEvent) => void): (() => void) | null {
    if (!this.current || this.current.id !== jobId) return null;
    const job = this.current;
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  isRunning(): boolean {
    return this.current !== null && !this.current.finished;
  }

  private async pump(job: RunningJob): Promise<void> {
    const readLines = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          this.emit(job, { type: "message", data: buf.slice(0, idx) });
          buf = buf.slice(idx + 1);
        }
      }
      if (buf) this.emit(job, { type: "message", data: buf });
    };

    await Promise.all([readLines(job.proc.stdout), readLines(job.proc.stderr)]);
    const exitCode = await job.proc.exited;
    if (job.finished) return; // already timed out
    clearTimeout(job.timeoutHandle);
    job.finished = true;
    if (exitCode === 0) {
      this.emit(job, { type: "done", data: "" });
    } else {
      this.emit(job, { type: "error", data: `claude exited with code ${exitCode}` });
    }
  }

  private timeoutJob(job: RunningJob): void {
    if (job.finished) return;
    job.finished = true;
    job.proc.kill();
    this.emit(job, { type: "error", data: "Apply run timed out" });
  }

  private emit(job: RunningJob, event: ApplyEvent): void {
    for (const listener of job.listeners) listener(event);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/apply.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && bun run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/apply.ts dashboard/tests/apply.test.ts
git commit -m "dashboard: add ApplyJobManager for headless /apply subprocess runs"
```

---

### Task 7: HTTP server

**Files:**
- Create: `dashboard/src/server.ts`
- Create: `dashboard/tests/server.test.ts`

**Interfaces:**
- Consumes: `loadDashboardData` (Task 5), `ApplyJobManager`, `ApplyEvent` (Task 6)
- Produces: `createFetchHandler(repoRoot: string, jobs: ApplyJobManager, publicDir: string): (req: Request) => Promise<Response>`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/server.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchHandler } from "../src/server";
import { ApplyJobManager } from "../src/apply";

function makeRepoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-server-test-"));
  writeFileSync(
    join(dir, "job_search_tracker.csv"),
    "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n" +
      "2026-01-01,Acme,Tech,Engineer,Full-time,portal,applied,,80,Good fit,cv/a.tex,cover_letters/a.tex,https://example.com\n",
  );
  mkdirSync(join(dir, "documents", "applications"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), "<html></html>");
  return dir;
}

describe("createFetchHandler", () => {
  test("GET /api/data returns parsed rows and stats", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/api/data"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.stats.total).toBe(1);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("POST /api/apply with no input returns 400", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(
      new Request("http://localhost/api/apply", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("POST /api/apply starts a job (202) and rejects a second concurrent one (409)", async () => {
    const repoRoot = makeRepoFixture();
    const jobs = new ApplyJobManager(() => ({
      stdout: null,
      stderr: null,
      exited: new Promise(() => {}),
      kill: () => {},
    }));
    const handler = createFetchHandler(repoRoot, jobs, join(repoRoot, "public"));
    const first = await handler(
      new Request("http://localhost/api/apply", {
        method: "POST",
        body: JSON.stringify({ input: "https://example.com/job" }),
      }),
    );
    expect(first.status).toBe(202);
    const second = await handler(
      new Request("http://localhost/api/apply", {
        method: "POST",
        body: JSON.stringify({ input: "https://example.com/other" }),
      }),
    );
    expect(second.status).toBe(409);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("POST /api/apply returns 500 (not 409) when the subprocess itself fails to start", async () => {
    const repoRoot = makeRepoFixture();
    const jobs = new ApplyJobManager(() => {
      throw new Error("spawn claude ENOENT");
    });
    const handler = createFetchHandler(repoRoot, jobs, join(repoRoot, "public"));
    const res = await handler(
      new Request("http://localhost/api/apply", {
        method: "POST",
        body: JSON.stringify({ input: "https://example.com/job" }),
      }),
    );
    expect(res.status).toBe(500);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET /api/apply/:id/events for an unknown job returns an SSE error event", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/api/apply/does-not-exist/events"));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: error");
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET / serves index.html", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html>");
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("rejects path traversal attempts on static assets", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/../../job_search_tracker.csv"));
    expect(res.status).toBe(404);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("unknown path returns 404", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/server.test.ts`
Expected: FAIL — `dashboard/src/server.ts` does not exist.

- [ ] **Step 3: Implement `server.ts`**

Create `dashboard/src/server.ts`:

```typescript
import { resolve, join } from "node:path";
import { loadDashboardData } from "./data";
import { ApplyJobManager, type ApplyEvent } from "./apply";

export function createFetchHandler(
  repoRoot: string,
  jobs: ApplyJobManager,
  publicDir: string,
): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/data" && req.method === "GET") {
      const data = await loadDashboardData(repoRoot);
      return Response.json(data);
    }

    if (url.pathname === "/api/apply" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const input = typeof (body as { input?: unknown } | null)?.input === "string"
        ? (body as { input: string }).input.trim()
        : "";
      if (!input) return Response.json({ error: "input is required" }, { status: 400 });
      const result = jobs.start(input);
      if ("error" in result) {
        // A result with a jobId means an apply is already running (409 conflict);
        // no jobId means the subprocess itself failed to start (500).
        return Response.json(result, { status: "jobId" in result ? 409 : 500 });
      }
      return Response.json(result, { status: 202 });
    }

    const eventsMatch = url.pathname.match(/^\/api\/apply\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const jobId = eventsMatch[1];
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: ApplyEvent) => {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${event.data}\n\n`));
            if (event.type !== "message") controller.close();
          };
          unsubscribe = jobs.subscribe(jobId, send);
          if (!unsubscribe) {
            controller.enqueue(encoder.encode(`event: error\ndata: unknown job\n\n`));
            controller.close();
          }
        },
        cancel() {
          unsubscribe?.();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolvedPublicDir = resolve(publicDir);
    const assetPath = resolve(join(publicDir, requestedPath));
    if (!assetPath.startsWith(resolvedPublicDir)) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(assetPath);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  };
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const publicDir = resolve(import.meta.dir, "..", "public");
  const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
  const jobs = new ApplyJobManager();
  const server = Bun.serve({ port, fetch: createFetchHandler(repoRoot, jobs, publicDir) });
  console.log(`Dashboard running at http://localhost:${server.port}`);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/server.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full backend test suite and typecheck**

Run: `cd dashboard && bun test && bun run typecheck`
Expected: all PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server.ts dashboard/tests/server.test.ts
git commit -m "dashboard: add HTTP server with /api/data, /api/apply, and SSE event routes"
```

---

### Task 8: Static shell (HTML + CSS)

**Files:**
- Create: `dashboard/public/index.html`
- Create: `dashboard/public/dashboard.css`

**Interfaces:**
- Produces: DOM element ids consumed by Task 9's JS: `generated-at`, `footer`, `warning-banner`, `refresh-btn`, `stat-cards`, `chart-status`, `chart-sector`, `chart-channel`, `chart-funnel`, `apply-form`, `apply-input`, `apply-submit`, `apply-status`, `apply-log`, `filter-status`, `filter-sector`, `filter-search`, `applications-tbody`

- [ ] **Step 1: Create `dashboard/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Job Search Dashboard</title>
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body>
  <header class="header">
    <h1>🔍 Job Search Dashboard</h1>
    <div class="header-actions">
      <span id="generated-at" class="generated-at"></span>
      <button id="refresh-btn" type="button">Refresh</button>
    </div>
  </header>

  <p id="warning-banner" class="warning-banner" hidden></p>

  <section class="stat-cards" id="stat-cards" aria-label="Summary statistics"></section>

  <section class="charts-grid">
    <div class="chart-card">
      <h3>Status breakdown</h3>
      <div id="chart-status"></div>
    </div>
    <div class="chart-card">
      <h3>By sector</h3>
      <div id="chart-sector"></div>
    </div>
    <div class="chart-card">
      <h3>By channel</h3>
      <div id="chart-channel"></div>
    </div>
    <div class="chart-card">
      <h3>Application funnel</h3>
      <div id="chart-funnel"></div>
    </div>
  </section>

  <section class="apply-section">
    <h2>Apply to a job</h2>
    <form id="apply-form">
      <textarea id="apply-input" rows="4" placeholder="Paste a job URL or the full job description"></textarea>
      <div class="apply-controls">
        <button id="apply-submit" type="submit">Run /apply</button>
        <span id="apply-status" class="apply-status"></span>
      </div>
      <pre id="apply-log" class="apply-log" hidden></pre>
    </form>
  </section>

  <section class="table-section">
    <h2>Applications</h2>
    <div class="table-filters">
      <select id="filter-status"><option value="">All statuses</option></select>
      <select id="filter-sector"><option value="">All sectors</option></select>
      <input id="filter-search" type="search" placeholder="Search company, role, sector" />
    </div>
    <div class="table-wrap">
      <table id="applications-table">
        <thead>
          <tr>
            <th>Date</th><th>Company</th><th>Role</th><th>Sector</th><th>Channel</th><th>Status</th><th>Notes</th><th>Source</th>
          </tr>
        </thead>
        <tbody id="applications-tbody"></tbody>
      </table>
    </div>
  </section>

  <footer class="footer" id="footer"></footer>

  <script type="module" src="/dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `dashboard/public/dashboard.css`**

```css
:root {
  --color-bg: #f8fafc;
  --color-card: #ffffff;
  --color-text: #0f172a;
  --color-muted: #64748b;
  --color-border: #e2e8f0;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--color-bg);
  color: var(--color-text);
  padding: 1.5rem;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.header h1 { margin: 0; font-size: 1.5rem; }
.header-actions { display: flex; align-items: center; gap: 0.75rem; }
.generated-at { color: var(--color-muted); font-size: 0.85rem; }

button {
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.9rem;
}
button:disabled { opacity: 0.6; cursor: not-allowed; }

.warning-banner {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.stat-card {
  background: var(--color-card);
  border-radius: 8px;
  border-left: 4px solid var(--color-muted);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  padding: 1rem;
}
.stat-card .value { font-size: 1.75rem; font-weight: 700; }
.stat-card .label { color: var(--color-muted); font-size: 0.85rem; }

.charts-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.chart-card {
  background: var(--color-card);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  padding: 1rem;
}
.chart-card h3 { margin-top: 0; font-size: 1rem; }

.legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin-top: 0.5rem; font-size: 0.8rem; }
.legend-item { display: flex; align-items: center; gap: 0.35rem; }
.legend-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

.apply-section, .table-section {
  background: var(--color-card);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  padding: 1rem;
  margin-bottom: 1.5rem;
}

#apply-input {
  width: 100%;
  font-family: inherit;
  padding: 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
}
.apply-controls { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem; }
.apply-status { color: var(--color-muted); font-size: 0.85rem; }

.apply-log {
  margin-top: 0.75rem;
  background: #0f172a;
  color: #e2e8f0;
  padding: 0.75rem;
  border-radius: 6px;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.8rem;
  white-space: pre-wrap;
}

.table-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
.table-filters select, .table-filters input {
  padding: 0.4rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
}

.table-wrap { overflow-x: auto; }

table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--color-border); }
tbody tr:nth-child(even) { background: #f1f5f9; }

.status-pill {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  color: white;
}

.footer { color: var(--color-muted); font-size: 0.8rem; text-align: center; margin-top: 1rem; }

@media (max-width: 899px) {
  .charts-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/public/index.html dashboard/public/dashboard.css
git commit -m "dashboard: add static HTML shell and stylesheet"
```

---

### Task 9: Client rendering logic and DOM glue

**Files:**
- Create: `dashboard/public/dashboard-logic.js`
- Create: `dashboard/public/dashboard.js`
- Create: `dashboard/tests/dashboard-logic.test.ts`

**Interfaces:**
- Consumes: `DashboardData` shape from `GET /api/data` (Task 7), DOM ids from Task 8
- Produces (from `dashboard-logic.js`, importable by both `dashboard.js` and its test): `STATUS_COLORS`, `truncate(text, max)`, `filterRows(rows, filters)`, `sortRowsNewestFirst(rows)`, `doughnutSlices(byBucket, colors)`, `barLengths(counts, maxWidth)`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/dashboard-logic.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { truncate, filterRows, sortRowsNewestFirst, doughnutSlices, barLengths } from "../public/dashboard-logic.js";

describe("truncate", () => {
  test("returns short text unchanged", () => {
    expect(truncate("short", 80)).toBe("short");
  });
  test("truncates long text with an ellipsis, preserving the max length", () => {
    const long = "a".repeat(100);
    const result = truncate(long, 10);
    expect(result).toBe("a".repeat(9) + "…");
    expect(result.length).toBe(10);
  });
  test("handles empty/undefined text", () => {
    expect(truncate("", 10)).toBe("");
    expect(truncate(undefined, 10)).toBe("");
  });
});

describe("filterRows", () => {
  const rows = [
    { company: "Acme", role: "Engineer", sector: "Tech", bucket: "Active" },
    { company: "Globex", role: "Manager", sector: "Finance", bucket: "Interview" },
  ];
  test("filters by status bucket", () => {
    expect(filterRows(rows, { status: "Interview" })).toEqual([rows[1]]);
  });
  test("filters by sector", () => {
    expect(filterRows(rows, { sector: "Tech" })).toEqual([rows[0]]);
  });
  test("filters by search term across company/role/sector, case-insensitive", () => {
    expect(filterRows(rows, { search: "globex" })).toEqual([rows[1]]);
  });
  test("combines status, sector, and search filters with AND", () => {
    expect(filterRows(rows, { status: "Active", sector: "Finance" })).toEqual([]);
  });
});

describe("sortRowsNewestFirst", () => {
  test("sorts by date descending, then company ascending", () => {
    const rows = [
      { date: "2026-01-01", company: "Zeta" },
      { date: "2026-02-01", company: "Alpha" },
      { date: "2026-02-01", company: "Beta" },
    ];
    expect(sortRowsNewestFirst(rows).map((r) => r.company)).toEqual(["Alpha", "Beta", "Zeta"]);
  });
});

describe("doughnutSlices", () => {
  test("returns an empty array when total is zero", () => {
    expect(doughnutSlices({ Active: 0, Interview: 0 }, {})).toEqual([]);
  });
  test("computes proportional angles summing to 360 degrees", () => {
    const slices = doughnutSlices({ Active: 3, Interview: 1 }, { Active: "#3b82f6", Interview: "#f59e0b" });
    expect(slices).toHaveLength(2);
    const totalSweep = slices.reduce((sum, s) => sum + (s.endAngle - s.startAngle), 0);
    expect(totalSweep).toBeCloseTo(360);
  });
});

describe("barLengths", () => {
  test("scales bars proportionally to the max value", () => {
    const bars = barLengths({ A: 10, B: 5 }, 100);
    expect(bars.find((b) => b.label === "A")?.width).toBe(100);
    expect(bars.find((b) => b.label === "B")?.width).toBe(50);
  });
  test("handles all-zero counts without dividing by zero", () => {
    const bars = barLengths({ A: 0, B: 0 }, 100);
    expect(bars.every((b) => Number.isFinite(b.width))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd dashboard && bun test tests/dashboard-logic.test.ts`
Expected: FAIL — `dashboard/public/dashboard-logic.js` does not exist.

- [ ] **Step 3: Implement `dashboard-logic.js`**

Create `dashboard/public/dashboard-logic.js`:

```javascript
export const STATUS_COLORS = {
  "Drafted": "#64748b",
  "Active": "#3b82f6",
  "Interview": "#f59e0b",
  "Offer": "#8b5cf6",
  "Hired": "#22c55e",
  "Rejected/Closed": "#ef4444",
};

export function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function filterRows(rows, { status, sector, search } = {}) {
  const term = (search || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (status && row.bucket !== status) return false;
    if (sector && row.sector !== sector) return false;
    if (term) {
      const haystack = `${row.company} ${row.role} ${row.sector}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

export function sortRowsNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.company.localeCompare(b.company);
  });
}

export function doughnutSlices(byBucket, colors) {
  const entries = Object.entries(byBucket).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return [];
  let angle = -90;
  return entries.map(([label, count]) => {
    const fraction = count / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    return { label, count, color: colors[label] ?? "#94a3b8", startAngle, endAngle };
  });
}

export function barLengths(counts, maxWidth) {
  const max = Math.max(1, ...Object.values(counts));
  return Object.entries(counts).map(([label, count]) => ({
    label,
    count,
    width: (count / max) * maxWidth,
  }));
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd dashboard && bun test tests/dashboard-logic.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Implement `dashboard.js` (DOM glue, not unit tested — verified manually in Step 7)**

Create `dashboard/public/dashboard.js`:

```javascript
import { STATUS_COLORS, truncate, filterRows, sortRowsNewestFirst, doughnutSlices, barLengths } from "./dashboard-logic.js";

const state = { rows: [], stats: null, filters: { status: "", sector: "", search: "" } };

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  return node;
}

async function loadData() {
  const res = await fetch("/api/data");
  const data = await res.json();
  state.rows = data.rows;
  state.stats = data.stats;

  document.getElementById("generated-at").textContent = `Generated: ${new Date(data.generatedAt).toLocaleString()}`;
  document.getElementById("footer").textContent = `Generated by Claude Code · ai-job-search · ${data.generatedAt}`;

  const banner = document.getElementById("warning-banner");
  if (data.warning) {
    banner.textContent = data.warning;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  populateFilterOptions();
  renderAll();
}

function populateFilterOptions() {
  const statusSelect = document.getElementById("filter-status");
  const sectorSelect = document.getElementById("filter-sector");
  const currentStatus = statusSelect.value;
  const currentSector = sectorSelect.value;

  statusSelect.innerHTML = "";
  statusSelect.appendChild(el("option", { value: "", text: "All statuses" }));
  for (const bucket of Object.keys(state.stats.byBucket)) {
    statusSelect.appendChild(el("option", { value: bucket, text: bucket }));
  }
  statusSelect.value = currentStatus;

  const sectors = [...new Set(state.rows.map((r) => r.sector).filter(Boolean))].sort();
  sectorSelect.innerHTML = "";
  sectorSelect.appendChild(el("option", { value: "", text: "All sectors" }));
  for (const sector of sectors) sectorSelect.appendChild(el("option", { value: sector, text: sector }));
  sectorSelect.value = currentSector;
}

function renderAll() {
  renderStatCards();
  renderCharts();
  renderTable();
}

function renderStatCards() {
  const container = document.getElementById("stat-cards");
  container.innerHTML = "";
  const cards = [
    { label: "Sent", value: state.stats.total, color: STATUS_COLORS.Active },
    { label: "Drafted", value: state.stats.draftedCount, color: STATUS_COLORS.Drafted },
    { label: "Active", value: state.stats.byBucket.Active, color: STATUS_COLORS.Active },
    { label: "Interview", value: state.stats.byBucket.Interview, color: STATUS_COLORS.Interview },
    { label: "Offer", value: state.stats.byBucket.Offer, color: STATUS_COLORS.Offer },
    { label: "Rejected/Closed", value: state.stats.byBucket["Rejected/Closed"], color: STATUS_COLORS["Rejected/Closed"] },
  ];
  for (const card of cards) {
    const node = el("div", { class: "stat-card", style: `border-left-color:${card.color}` });
    node.appendChild(el("div", { class: "value", text: String(card.value) }));
    node.appendChild(el("div", { class: "label", text: card.label }));
    container.appendChild(node);
  }
}

function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function renderDoughnut(container, byBucket) {
  container.innerHTML = "";
  const slices = doughnutSlices(byBucket, STATUS_COLORS);
  const size = 180, cx = size / 2, cy = size / 2, r = size / 2 - 10;
  const summary = slices.map((s) => `${s.count} ${s.label}`).join(", ") || "no data";
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img", "aria-label": `Status breakdown: ${summary}` });
  for (const slice of slices) {
    const start = polarToCartesian(cx, cy, r, slice.startAngle);
    const end = polarToCartesian(cx, cy, r, slice.endAngle);
    const largeArc = slice.endAngle - slice.startAngle > 180 ? 1 : 0;
    const path = `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
    svg.appendChild(svgEl("path", { d: path, fill: slice.color }));
  }
  container.appendChild(svg);

  const legend = el("div", { class: "legend" });
  for (const slice of slices) {
    const item = el("div", { class: "legend-item" });
    item.appendChild(el("span", { class: "legend-swatch", style: `background:${slice.color}` }));
    item.appendChild(el("span", { text: `${slice.label} (${slice.count})` }));
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

function renderBarChart(container, counts, ariaLabel) {
  container.innerHTML = "";
  const maxWidth = 220;
  const bars = barLengths(counts, maxWidth);
  const svg = svgEl("svg", { viewBox: `0 0 300 ${bars.length * 28 + 10}`, width: "100%", height: bars.length * 28 + 10, role: "img", "aria-label": ariaLabel });
  bars.forEach((bar, i) => {
    const y = i * 28 + 5;
    svg.appendChild(svgEl("rect", { x: 0, y, width: Math.max(bar.width, 1), height: 18, fill: STATUS_COLORS[bar.label] ?? "#3b82f6" }));
    const text = svgEl("text", { x: bar.width + 6, y: y + 13, "font-size": 11, fill: "#0f172a" });
    text.textContent = `${bar.label} (${bar.count})`;
    svg.appendChild(text);
  });
  container.appendChild(svg);
}

function renderCharts() {
  renderDoughnut(document.getElementById("chart-status"), state.stats.byBucket);
  renderBarChart(document.getElementById("chart-sector"), state.stats.bySector, "Applications by sector");
  renderBarChart(document.getElementById("chart-channel"), state.stats.byChannel, "Applications by channel");
  renderBarChart(
    document.getElementById("chart-funnel"),
    {
      Applied: state.stats.funnel.applied,
      Interview: state.stats.funnel.interview,
      Offer: state.stats.funnel.offer,
      Hired: state.stats.funnel.hired,
    },
    "Application funnel",
  );
}

function renderTable() {
  const tbody = document.getElementById("applications-tbody");
  tbody.innerHTML = "";
  const filtered = sortRowsNewestFirst(filterRows(state.rows, state.filters));
  for (const row of filtered) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", { text: row.date || "—" }));
    tr.appendChild(el("td", { text: row.company || "—" }));
    tr.appendChild(el("td", { text: row.role || "—" }));
    tr.appendChild(el("td", { text: row.sector || "—" }));
    tr.appendChild(el("td", { text: row.channel || "—" }));

    const statusTd = document.createElement("td");
    statusTd.appendChild(el("span", { class: "status-pill", style: `background:${STATUS_COLORS[row.bucket] ?? "#64748b"}`, text: row.bucket }));
    tr.appendChild(statusTd);

    const notesTd = el("td", { text: truncate(row.notes, 80) });
    if (row.notes) notesTd.title = row.notes;
    tr.appendChild(notesTd);

    const sourceTd = document.createElement("td");
    if (row.source && row.source.startsWith("http")) {
      sourceTd.appendChild(el("a", { href: row.source, target: "_blank", rel: "noopener noreferrer", text: "link" }));
    } else {
      sourceTd.textContent = "—";
    }
    tr.appendChild(sourceTd);

    tbody.appendChild(tr);
  }
}

function wireFilters() {
  document.getElementById("filter-status").addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    renderTable();
  });
  document.getElementById("filter-sector").addEventListener("change", (e) => {
    state.filters.sector = e.target.value;
    renderTable();
  });
  document.getElementById("filter-search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderTable();
  });
  document.getElementById("refresh-btn").addEventListener("click", loadData);
}

function wireApplyForm() {
  const form = document.getElementById("apply-form");
  const submitBtn = document.getElementById("apply-submit");
  const statusEl = document.getElementById("apply-status");
  const logEl = document.getElementById("apply-log");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("apply-input").value.trim();
    if (!input) return;

    submitBtn.disabled = true;
    statusEl.textContent = "Starting…";
    logEl.hidden = false;
    logEl.textContent = "";

    const res = await fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });

    if (res.status === 409) {
      const body = await res.json();
      statusEl.textContent = `Already running (job ${body.jobId})`;
      submitBtn.disabled = false;
      return;
    }
    if (!res.ok) {
      statusEl.textContent = "Failed to start";
      submitBtn.disabled = false;
      return;
    }

    const { jobId } = await res.json();
    statusEl.textContent = "Running…";
    const source = new EventSource(`/api/apply/${jobId}/events`);

    source.addEventListener("message", (event) => {
      logEl.textContent += event.data + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    });
    source.addEventListener("done", () => {
      statusEl.textContent = "Done — click Refresh to see the new application";
      submitBtn.disabled = false;
      source.close();
    });
    // Note: EventSource's native connection-error event and our custom SSE "error"
    // event both surface here under the type "error" - event.data is only set
    // for the latter, so the fallback text covers the former gracefully.
    source.addEventListener("error", (event) => {
      statusEl.textContent = `Error: ${event.data || "apply run failed"}`;
      submitBtn.disabled = false;
      source.close();
    });
  });
}

wireFilters();
wireApplyForm();
loadData();
```

- [ ] **Step 6: Typecheck the backend (dashboard.js/dashboard-logic.js are plain JS, not part of tsc)**

Run: `cd dashboard && bun run typecheck && bun test`
Expected: no type errors, all tests PASS

- [ ] **Step 7: Manual verification**

```bash
cd dashboard && bun run src/server.ts
```

Open `http://localhost:4173` in a browser and verify:
- Stat cards, charts, and the applications table render with real data from `job_search_tracker.csv`
- Status/sector filters and the search box narrow the table correctly, combined with AND
- Clicking Refresh re-fetches and re-renders
- The apply form accepts a pasted URL or job text; submitting shows a live log and a final Done/Error status (a full real run can take several minutes — it's fine to verify the request starts and streams output, without necessarily waiting for a full `/apply` completion)
- Submitting a second apply while one is running shows the "already running" message instead of erroring

Stop the server with Ctrl-C when done.

- [ ] **Step 8: Commit**

```bash
git add dashboard/public/dashboard-logic.js dashboard/public/dashboard.js dashboard/tests/dashboard-logic.test.ts
git commit -m "dashboard: add client-side rendering (stat cards, SVG charts, filterable table, apply form)"
```

---

### Task 10: `/dashboard` slash command

**Files:**
- Create: `.claude/commands/dashboard.md`
- Delete: `.claude/commands/html-report.md`

**Interfaces:**
- Consumes: `dashboard/src/server.ts` (Task 7), default port `4173` (Global Constraints)

- [ ] **Step 1: Create `.claude/commands/dashboard.md`**

```markdown
# /dashboard - Run the Job Search Dashboard

Start the local dashboard server and open it in a browser. Replaces the old `/html-report` command: instead of writing a static file, this runs a live local web app that reads `job_search_tracker.csv` and `documents/applications/` on demand, and can trigger `/apply` on a pasted URL or job description.

## Step 0: Parse Arguments

- No argument → use the default port `4173`
- A numeric argument (e.g. `/dashboard 5000`) → use that port instead

## Step 1: Install Dependencies (first run only)

Check whether `dashboard/node_modules/` exists. If not, run:

```bash
cd dashboard && bun install
```

## Step 2: Start the Server

Run in the background (use the Bash tool's background-execution option) so this command can continue and open the browser:

```bash
cd dashboard && PORT=<port> bun run src/server.ts
```

Wait a moment, then check the background output for the line `Dashboard running at http://localhost:<port>` to confirm it started. If the port is already in use, the server prints an error and exits — report that error to the user rather than silently retrying on a different port.

## Step 3: Open the Browser

On macOS, run:

```bash
open http://localhost:<port>
```

Whether or not this succeeds (it won't on non-macOS platforms), print the URL so the user can open it manually.

## Step 4: Confirm

> **Dashboard running:** http://localhost:<port>
>
> - View applications, filters, and charts — refresh with the button in the page (no auto-refresh; if you've just run `/apply` or `/outcome` elsewhere, click Refresh to see it).
> - Paste a job URL or description into the "Apply to a job" form to run `/apply` end-to-end unattended, with progress streamed live.
> - Stop the server with Ctrl-C in the terminal running it, or kill the background process, when you're done.

## Design Principles

- **Read-only by default, one write path.** The dashboard never edits `job_search_tracker.csv` or `documents/applications/` directly — the only way it changes data is indirectly, by triggering the existing `/apply` skill.
- **No auto-refresh.** Data is re-read only on page load or the Refresh button, matching the deliberate design choice over live file watching.
- **Local only.** Binds to `localhost`; not exposed to the network.
```

- [ ] **Step 2: Delete the retired command**

```bash
rm .claude/commands/html-report.md
```

- [ ] **Step 3: Run the skill linter**

Run: `python3 tools/lint_skills.py`
Expected: `lint_skills: OK (... commands, settings.json)` — `dashboard.md` counted, `html-report.md` gone

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/dashboard.md
git rm .claude/commands/html-report.md
git commit -m "commands: replace /html-report with /dashboard"
```

---

### Task 11: Replace the structural test and clean up

**Files:**
- Create: `tests/test_dashboard_command.py`
- Delete: `tests/test_html_report_command.py`

**Interfaces:**
- Consumes: `.claude/commands/dashboard.md` (Task 10)

- [ ] **Step 1: Write the failing test**

Create `tests/test_dashboard_command.py`:

```python
"""Tests for the /dashboard command.

Mirrors the pattern in test_security_guards.py: one class that verifies
properties of the real repo, testing the things CI would catch if the
command file were wrong. Replaces test_html_report_command.py now that
/dashboard has taken over from /html-report.
"""

import subprocess
import sys
import unittest
from pathlib import Path

try:
    import yaml  # noqa: F401 - only probing availability for the lint integration test
    _HAVE_YAML = True
except ImportError:
    _HAVE_YAML = False

REPO_ROOT = Path(__file__).resolve().parent.parent
COMMAND_FILE = REPO_ROOT / ".claude" / "commands" / "dashboard.md"
OLD_COMMAND_FILE = REPO_ROOT / ".claude" / "commands" / "html-report.md"
LINT_SCRIPT = REPO_ROOT / "tools" / "lint_skills.py"


class DashboardCommandFileTests(unittest.TestCase):
    """Structural checks on the command file itself."""

    def test_command_file_exists(self):
        self.assertTrue(COMMAND_FILE.exists(), f"{COMMAND_FILE} not found")

    def test_command_file_starts_with_correct_header(self):
        """lint_skills.py rejects command files that don't start with '# /<name>'."""
        text = COMMAND_FILE.read_text(encoding="utf-8")
        first_line = text.lstrip().splitlines()[0]
        self.assertTrue(
            first_line.startswith("# /dashboard"),
            f"Command file must start with '# /dashboard', got: {first_line!r}",
        )

    def test_command_file_is_non_empty(self):
        text = COMMAND_FILE.read_text(encoding="utf-8").strip()
        self.assertGreater(len(text), 100, "Command file appears suspiciously short")

    def test_old_html_report_command_is_retired(self):
        self.assertFalse(
            OLD_COMMAND_FILE.exists(),
            "html-report.md should have been removed when /dashboard replaced it",
        )


@unittest.skipUnless(
    _HAVE_YAML,
    "PyYAML not installed (the CI Python-test job omits it; the lint job runs lint_skills.py directly)",
)
class DashboardLintIntegrationTests(unittest.TestCase):
    """lint_skills.py must pass after the command is added."""

    def test_lint_passes_on_real_repo(self):
        result = subprocess.run(
            [sys.executable, str(LINT_SCRIPT)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"lint_skills.py failed:\n{result.stdout}{result.stderr}",
        )
        self.assertIn("OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Delete the retired test**

```bash
rm tests/test_html_report_command.py
```

- [ ] **Step 3: Run the new test, verify it passes**

Run: `python3 -m pytest tests/test_dashboard_command.py -v`
Expected: all PASS (or the lint integration test SKIPPED if PyYAML isn't installed)

- [ ] **Step 4: Run the full Python test suite to confirm nothing else references the old command**

Run: `python3 -m pytest tests/ -v`
Expected: all PASS

- [ ] **Step 5: Run the full dashboard test suite one more time end-to-end**

Run: `cd dashboard && bun test && bun run typecheck`
Expected: all PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add tests/test_dashboard_command.py
git rm tests/test_html_report_command.py
git commit -m "tests: replace test_html_report_command.py with test_dashboard_command.py"
```
