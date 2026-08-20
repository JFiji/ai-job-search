# Job Application Dashboard GUI — Design

Status: Approved (dashboard + apply-trigger). `/rank` and `/scrape` triggering remain deferred to a follow-up spec.
Date: 2026-08-20

## Purpose

Give the job-search workflow a GUI:

1. **Dashboard** — a local, interactive, always-available view of `job_search_tracker.csv` and the application archives, replacing the static `/html-report` command.
2. **Apply trigger** — submit a job (URL or pasted job spec) from the GUI and have it run the full `/apply` pipeline unattended, with progress streamed to the browser.
3. **Deferred (future spec)** — triggering `/rank` and `/scrape` from the GUI. Not built here, but the architecture (JSON API + a subprocess-trigger pattern) is chosen so adding them later is additive.

**Dependency, tracked separately:** a change to `/apply` itself — government-sector applications should output plain `.txt` CV/cover letter instead of LaTeX/PDF, and generated writing should get a naturalness/tone pass so it reads less AI-generated. This applies to `/apply` everywhere (terminal and GUI), touches the LaTeX pipeline, the CV/cover-letter template system, the anonymization flow, and the PDF-focused verification checklist — a different subsystem from the GUI. It gets its own brainstorm/spec before or alongside implementing this one; the GUI's apply-trigger simply invokes `/apply` and inherits whatever that skill produces once it lands.

## Decisions

| Question | Decision |
|---|---|
| Primary purpose | Dashboard + apply-trigger; `/rank`/`/scrape` triggering later |
| Delivery | Local web app (Bun server on localhost) |
| Backend stack | Node/Bun, TypeScript |
| Data freshness | Manual refresh (button), no live file watching |
| Relationship to `/html-report` | Replace it |
| Apply-trigger execution | GUI shells out to the Claude Code CLI (`claude -p "/apply <input>"`), streamed back to the browser via SSE |
| Apply-trigger interactivity | Fire-and-forget — runs end-to-end unattended (see "Apply trigger" section) |
| Internal architecture | JSON API (`/api/data`, `/api/apply`) + client-rendered UI, not server-rendered HTML per request |

## Architecture

New top-level `dashboard/` directory, sibling to `job_scraper/` and `tools/`:

```
dashboard/
  package.json          # bun test / tsc --noEmit scripts, minimal/zero runtime deps
  src/
    server.ts           # Bun.serve() entrypoint
    data.ts             # CSV parsing, outcome.md merge, stat computation
    data.test.ts         # bun test coverage for data.ts
  public/
    index.html           # static shell
    dashboard.css
    dashboard.js          # fetches /api/data, renders cards/charts/table
```

Routes on `src/server.ts`:
- `GET /` — serves the static shell (`public/index.html`)
- `GET /api/data` — computes and returns the current dataset as JSON
- `POST /api/apply` — starts a headless `/apply` run (see "Apply trigger" below)
- `GET /api/apply/:jobId/events` — SSE stream of that run's output
- static assets served from `public/`

A new slash command `.claude/commands/dashboard.md` replaces `.claude/commands/html-report.md`. It:
- Starts the Bun server in the background (`bun dashboard/src/server.ts`), default port `4173`, overridable via an argument
- Opens the browser (`open http://localhost:PORT` on macOS) and prints the URL regardless, in case auto-open fails or the platform differs
- On port-in-use, surfaces the server's error to the user rather than silently picking another port

This ports the data/stat logic that currently exists only as *prose instructions* in `.claude/commands/html-report.md` (read by Claude fresh on every run) into real, testable TypeScript that runs deterministically as a server.

## Apply trigger

A form on the dashboard page: a single textarea (placeholder "Paste a job URL or the full job description"), mirroring `/apply`'s existing CLI ergonomics (`/apply <url>` or `/apply <pasted text>` — the skill itself already disambiguates, so the GUI doesn't need to).

**Submission:**
1. `POST /api/apply { input: string }`. Server rejects with `409` if a run is already in progress — one apply job at a time, no queue, matching a personal-scale tool.
2. Server generates a `jobId`, spawns the subprocess as **`Bun.spawn(["claude", "-p", "/apply " + input])`** — array-form arguments, never shell string interpolation, so a pasted job description can never be interpreted as shell syntax (the input is untrusted, copied from external job postings).
3. Returns `202 { jobId }` immediately.
4. Client opens `EventSource` on `GET /api/apply/:jobId/events`, which streams the subprocess's stdout/stderr line-by-line as SSE `message` events, and a final `done` (exit code 0) or `error` (non-zero exit, spawn failure, or timeout) event.
5. A generous but bounded timeout (default 15 minutes, matching the reviewer-critique-revise pipeline's expected runtime) kills the subprocess and emits `error` if exceeded — prevents an orphaned process if the headless run ever hits a stuck state.
6. On `done`, the client shows a "Refresh dashboard" prompt (since `/apply` writes a new row to `job_search_tracker.csv`) rather than auto-refreshing, consistent with the manual-refresh decision.

**Fire-and-forget / no mid-flow prompts:** the headless `claude -p` invocation is one-shot — there is no channel for `/apply`'s normal interactive confirmations (fit-evaluation presentation, government-role anonymization y/n) to pause and wait for a reply. The run must go end-to-end unattended:
- Fit evaluation happens, but doesn't block: if fit is reasonable, `/apply` proceeds straight to drafting (matching the existing pasted-job-spec skip-gate behavior already used elsewhere in this workflow).
- Anonymization for detected government/public-sector roles defaults to on rather than asking.
- Output format for government roles (plain `.txt` vs LaTeX/PDF) and the writing-naturalness pass are inherited from whatever `/apply` produces once the separate dependency above lands — the GUI does not special-case this itself.
- The full log (everything `/apply` printed) stays visible in the browser after completion so nothing is hidden just because no one was there to watch it run.

## Data flow

1. Browser loads `/` → static shell (HTML/CSS/JS, no server-side templating).
2. Shell JS calls `GET /api/data`.
3. Server reads `job_search_tracker.csv` and every `documents/applications/*/outcome.md` fresh off disk — no caching, no file watching, matching the "manual refresh" decision.
4. Server fuzzy-matches outcome archives to tracker rows by lowercased, punctuation-stripped company+role.
5. Server normalizes `status` into six canonical buckets: Drafted, Active, Interview, Offer, Hired, Rejected/Closed (tolerating legacy space-spelled values and unrecognized values, bucketed into Rejected/Closed and named once in the breakdown).
6. Server computes: total applications (Drafted excluded from every stat except its own count and the status breakdown), counts by status/sector/channel/year, funnel rate (% reaching Interview or beyond), rejection rate (Rejected/Closed ÷ resolved, excluding Active).
7. Server returns `{ rows, stats, generatedAt, warning? }` as JSON.
8. Client renders:
   - 6 stat cards (Sent, Drafted, Active, Interview, Offer, Rejected/Closed)
   - 4 inline SVG charts: status doughnut, by-sector bar, by-channel bar, funnel bar — same color palette and chart types as the current `/html-report` spec
   - A filterable table (status dropdown, sector dropdown, text search across company/role/sector, all combine with AND; sorted newest-first by date then company) with columns Date, Company, Role, Sector, Channel, Status, Notes (truncated to 80 chars, full text in a tooltip), Source (rendered as a link if it starts with `http`, else `—`)
9. A refresh button re-fetches `/api/data` and re-renders in place.

Client rendering uses DOM APIs (`textContent`, element creation) rather than string concatenation into `innerHTML` — the correct client-side equivalent of the old prompt's manual HTML-escaping requirement, since untrusted values (company names, notes) come from job postings.

## Error handling

- Missing or unreadable `job_search_tracker.csv` → `/api/data` returns `200` with an empty dataset and a `warning` string; the client displays it inline instead of a blank/broken page. Matches the existing "graceful on sparse data" principle.
- Malformed CSV rows (wrong column count) → skipped, counted, and folded into the same `warning` field rather than crashing the server.
- Port already in use → the server exits with a clear message; the `/dashboard` command surfaces this to the user rather than silently retrying on a different port.
- `claude` CLI missing/not authenticated, or spawn failure → `POST /api/apply` returns the failure immediately as an `error` SSE event (no silent hang).
- Apply run exceeds the timeout → subprocess is killed, `error` event emitted with a clear "timed out" message, job slot freed so a new apply can be started.
- Second apply submitted while one is running → `409` with the in-progress `jobId`, client disables the form and shows the running job's stream instead of erroring silently.

## Testing

- `dashboard/src/data.test.ts` (`bun test`): unit tests for CSV parsing, status normalization (including legacy space-spelling tolerance and unrecognized-value bucketing), funnel/rejection-rate math, and `outcome.md` fuzzy-matching. These pin the behavioral guarantees that today live only as prose in `html-report.md`.
- `dashboard/src/apply.test.ts` (`bun test`): asserts the subprocess is invoked with array-form arguments (never a shell string), that a second concurrent submission gets `409`, and that the timeout path emits `error` and frees the job slot. Subprocess execution itself is mocked/stubbed — these tests don't actually run `claude`.
- A slim Python structural test (mirroring the pattern in `tests/test_html_report_command.py`) asserting `.claude/commands/dashboard.md` exists and documents the right invocation.
- No e2e/browser test framework. Manual click-through (start server, open browser, exercise filters/refresh, and submit one real apply run end-to-end) is the acceptance check — consistent with a personal-scale tool.

## Migration

- Retire `.claude/commands/html-report.md`.
- Retire or rewrite `tests/test_html_report_command.py` to instead test `.claude/commands/dashboard.md`'s structural properties.
- No direct changes to `job_search_tracker.csv`, `documents/applications/`, or any other command — the dashboard itself is read-only; the only write path is indirect, through the existing `/apply` skill when triggered via the apply form.

## Out of scope (this spec)

- **`/rank` and `/scrape` triggering from the GUI.** Deferred to a follow-up spec. The `POST /api/apply` + SSE pattern built here is the template for adding them later without restructuring.
- **The `/apply` document-generation change** (`.txt` output for government roles, humanized/naturalness tone pass, applies everywhere). Tracked as a separate dependency — see "Purpose" above. Needs its own brainstorm/spec since it touches the LaTeX pipeline, template system, and verification checklist, not the GUI.
- Authentication/access control — binds to localhost only, single local user.
- Auto-refresh / live file watching — explicitly rejected in favor of a manual refresh button.
- Editing tracker data from the GUI — the dashboard is read-only aside from the apply-trigger; the tracker stays the system of record, written only by `/apply` and `/outcome`.
