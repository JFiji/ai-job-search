# Dashboard Search & Rank Triggers — Design

Status: Approved. Builds on and partially supersedes `2026-08-20-job-application-gui-design.md` (the apply-trigger concurrency rule below replaces that spec's "409 on concurrent submission" constraint).
Date: 2026-08-20

## Purpose

Add `/scrape` and `/rank` as triggerable actions in the dashboard, alongside the already-shipped `/apply` trigger, plus a new **ranked-jobs table** reading `job_scraper/seen_jobs.json` so the results of scraping/ranking are actually visible and actionable (one-click Apply per row) rather than only readable from a scrolling log.

This requires a real architectural change: the existing `ApplyJobManager` (one job, reject-on-conflict) becomes a generalized `ActionQueueManager` that queues `apply`/`scrape`/`rank` actions and runs them one at a time, auto-advancing — not rejecting concurrent submissions.

## Decisions

| Question | Decision |
|---|---|
| Concurrency model | Shared single execution slot across all three action kinds, but **queued** — submissions no longer get rejected, they wait their turn and run automatically |
| Queue visibility | Visible queue panel: every action ever submitted this session, in order, with its status |
| Ranked-jobs table scope | Only `status: "new"` and `status: "ranked"` entries from `seen_jobs.json` — not expired/skipped/evaluated |
| Apply-button behavior | One click enqueues the apply run immediately using that row's `url` — no pre-fill/confirm step |
| Failed queue items | Marked `error` with the reason (from the terminal SSE event's data), not silently dropped; queue auto-advances to the next item regardless |
| `/rank`'s "pass triage verdict to /apply" | Out of scope — one-click Apply submits the URL only, identical to typing it into the form manually |
| `/scrape`'s optional Step 6 (interactive tracker update) | Out of scope — doesn't fire headlessly in the original skill either |
| Cancelling a running (not queued) action | Out of scope — only queued-not-yet-started items are cancellable |

## Architecture

**Rename `dashboard/src/apply.ts` → `dashboard/src/actions.ts`.** This is a deliberate rename/restructure of already-shipped, reviewed code — `ApplyJobManager` is no longer apply-specific, so its name shouldn't be either. `ApplyEvent` → `ActionEvent`.

```ts
export type ActionKind = "apply" | "scrape" | "rank";

export interface QueuedAction {
  id: string;
  kind: ActionKind;
  label: string;              // human-readable, e.g. "/apply https://..." or "/scrape data science" or "/rank"
  status: "queued" | "running" | "done" | "error" | "cancelled";
  errorReason?: string;       // set when status is "error"
  enqueuedAt: string;         // ISO timestamp
}

export function buildCommand(kind: ActionKind, params: { input?: string; focus?: string }): string[] {
  switch (kind) {
    case "apply": return ["claude", "-p", `/apply ${params.input}`];
    case "scrape": return params.focus ? ["claude", "-p", `/scrape ${params.focus}`] : ["claude", "-p", "/scrape"];
    case "rank": return ["claude", "-p", "/rank"];
  }
}
```

`ActionQueueManager` holds the full session history (not just pending items) as an in-memory array — lost on server restart, matching the existing "no persistence beyond what the underlying commands themselves write" philosophy. Public surface:

- `enqueue(kind, params): { actionId }` — always succeeds (never rejects); if nothing is running, starts immediately; otherwise appends with `status: "queued"`.
- `cancel(actionId): boolean` — removes a `"queued"` item, sets its status to `"cancelled"`; returns `false` (no-op) if the item is already running, finished, or doesn't exist.
- `subscribe(listener): () => void` — registers a listener for the persistent queue stream (see below); immediately delivers the current snapshot to a new subscriber, so a late/reconnecting subscriber always sees current state (though not replayed log history for an in-progress action — accepted limitation).
- Internal: on an action's process exit, sets its final status (`done` on exit code 0, `error` with `errorReason` otherwise — reusing the array-form-spawn and try/catch-around-spawn safety already built for `/apply`), then immediately starts the next `"queued"` item if one exists. A queued item's failure never blocks or skips subsequent items.

**New module `dashboard/src/jobs.ts`** parses `job_scraper/seen_jobs.json`:

```ts
export interface JobEntry {
  key: string;
  title: string;
  company: string;
  url: string;
  first_seen: string;
  fit: "high" | "medium" | "low" | string;
  status: "new" | "ranked" | string;
  portal: string;
  rank_score?: number;
  rank_verdict?: string;
  rank_date?: string;
  strengths?: string[];
  gaps?: string[];
  location?: "PASS" | "FAIL" | "FLAG";
  language_gate?: "PASS" | "FAIL" | "FLAG";
}

export function loadJobsList(repoRoot: string): Promise<{ jobs: JobEntry[]; warning?: string }>
```

Filters to `status === "new" || status === "ranked"`, sorted by `rank_score` descending with unscored (`new`) entries sorted after by `first_seen` descending. Missing/unreadable `seen_jobs.json` → empty list + warning, same graceful pattern as `loadDashboardData`.

## API

- `GET /api/data` — unchanged.
- `GET /api/jobs` — new/ranked jobs from `seen_jobs.json`, via `loadJobsList`.
- `POST /api/actions { kind: "apply"|"scrape"|"rank", input?: string, focus?: string }` — validates `input` is required (non-empty) for `kind: "apply"`; `focus` is always optional. Enqueues via `ActionQueueManager.enqueue`, returns `202 { actionId }`. Never returns 409 — this replaces `POST /api/apply`, which is removed.
- `DELETE /api/actions/:id` — cancels a queued item. `200` with updated snapshot on success (only when the item's status is exactly `"queued"`); `409` if its status is `"running"`, `"done"`, `"error"`, or already `"cancelled"`; `404` if the id is unknown.
- `GET /api/queue/events` — **one persistent SSE stream**, replacing the old per-submission `GET /api/apply/:jobId/events`. Two event types:
  - `queue` — full `QueuedAction[]` snapshot as JSON, sent immediately on connect and again on every state change (item added/started/finished/cancelled).
  - `message` — a single stdout/stderr line from whichever action is currently running.

  No separate `done`/`error` SSE event types — a finished action is communicated entirely through its `status` in the next `queue` snapshot, which simplifies the protocol versus the original per-job design.

## Data flow

1. On page load, the client opens exactly one `EventSource` on `/api/queue/events` (not per-submission) and keeps it open for the page's lifetime.
2. The queue panel renders from `queue` snapshots: queued items (with a Cancel button), the running item, and finished items (done/error/cancelled) with `errorReason` shown inline for errors.
3. The log panel appends `message` lines for whatever's currently running; it clears when the running item's `id` changes (a new action started), and otherwise persists the last action's output so it doesn't vanish the instant something finishes.
4. Scrape trigger: a button + optional focus text input → `POST /api/actions {kind:"scrape", focus}`.
5. Rank trigger: a button, no inputs for v1 (deliberately not exposing `--all`/`--top N` yet — YAGNI, can add later if actually needed) → `POST /api/actions {kind:"rank"}`.
6. Apply trigger (existing textarea) → `POST /api/actions {kind:"apply", input}`, same paste-URL-or-job-spec UX as before.
7. Ranked-jobs table: fetched via `GET /api/jobs` (manual refresh, same button as the applications table — one Refresh action re-fetches both `/api/data` and `/api/jobs`). Each row's Apply button → `POST /api/actions {kind:"apply", input: row.url}` immediately, no confirmation.
8. When a `scrape` or `rank` action finishes, its output (new/updated `seen_jobs.json` entries) isn't auto-reflected — same manual-refresh principle as the tracker table. The user clicks Refresh to see new rows.

## Error handling

- A queued item that fails (non-zero exit, spawn failure) is marked `status: "error"` with `errorReason` set from the terminal event's data — visible in the queue panel, not silently removed.
- The queue always advances to the next `"queued"` item after the current one finishes, whether it succeeded or failed. No cross-item dependency logic: if `/rank` runs right after a failed `/scrape`, it simply hits its own existing "nothing new to rank" behavior gracefully (that's `/rank`'s own Step 1 handling, unchanged).
- `seen_jobs.json` missing/unreadable → `GET /api/jobs` returns an empty list with a `warning`, same pattern as the tracker CSV.
- `DELETE /api/actions/:id` on an already-started item → `409`, not a silent no-op with a misleading 200.

## Testing

- `dashboard/tests/actions.test.ts` (replaces `apply.test.ts`): `buildCommand` for all three kinds (array-form args, no shell strings); queue ordering (FIFO, auto-advance); a failing item doesn't block the next one and carries `errorReason`; cancel only affects queued items; late-subscriber snapshot delivery.
- `dashboard/tests/jobs.test.ts`: `loadJobsList` filtering (new+ranked only, excludes expired/skipped/evaluated), sort order (ranked by score desc, new after by date desc), missing-file warning.
- `dashboard/tests/server.test.ts`: updated for `/api/jobs`, `/api/actions` (POST + DELETE), `/api/queue/events` (SSE framing, both event types) — replaces the old `/api/apply`/`/api/apply/:jobId/events` tests.
- Client (`dashboard.js`/`dashboard-logic.js`): pure logic (queue-panel rendering data shape, ranked-table sort/format helpers) tested in `dashboard-logic.test.ts`; DOM glue changes verified manually, consistent with the existing testing approach for this file.

## Migration

- Delete `dashboard/src/apply.ts` and `dashboard/tests/apply.test.ts`; replaced by `actions.ts`/`actions.test.ts`.
- `server.ts`: remove `POST /api/apply` and `GET /api/apply/:jobId/events`; add the four new/changed routes above.
- `dashboard.js`: replace per-submission `EventSource` creation with the single page-load-time connection; apply form now just POSTs and re-enables its button on the response (no more waiting for SSE completion to re-enable, since the queue panel is now the source of truth for progress) — this also naturally absorbs the "apply-form stuck disabled" fix from the final whole-branch review, since the button no longer stays disabled across the run at all.
- This spec **supersedes** the original design spec's Global Constraint "One apply job at a time — a second `POST /api/apply` while one is running returns `409`." The new rule is: unlimited queueing, no rejection, ever.

## Out of scope (this spec)

- Exposing `/rank`'s `--all`/`--top N` or `/scrape`'s `broad`/`health` modes in the UI — v1 uses defaults only.
- Passing `/rank`'s triage verdict as context into the one-click Apply.
- Cancelling a currently-running action.
- Persisting the queue across server restarts.
- Any UI for `seen_jobs.json` entries with `status` other than `new`/`ranked` (expired, skipped, evaluated).
