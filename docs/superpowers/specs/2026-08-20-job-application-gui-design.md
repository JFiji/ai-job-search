# Job Application Dashboard GUI — Design

Status: Approved (dashboard phase). Operate phase deferred to a follow-up spec.
Date: 2026-08-20

## Purpose

Give the job-search workflow a GUI, phased in two parts:

1. **Dashboard (this spec)** — a local, interactive, always-available view of `job_search_tracker.csv` and the application archives, replacing the static `/html-report` command.
2. **Operate (future, out of scope here)** — trigger the actual workflow (`/apply`, `/rank`, `/scrape`) from the GUI, with Claude Code doing the work behind the scenes.

The dashboard phase is architected so the operate phase can be added without a rewrite.

## Decisions

| Question | Decision |
|---|---|
| Primary purpose | Dashboard first, action-triggering later |
| Delivery | Local web app (Bun server on localhost) |
| Backend stack | Node/Bun, TypeScript |
| Data freshness | Manual refresh (button), no live file watching |
| Relationship to `/html-report` | Replace it |
| Future action-triggering mechanism | GUI shells out to the Claude Code CLI (e.g. `claude -p "/apply <url>"`), streamed back to the browser |
| Internal architecture | JSON API (`/api/data`) + client-rendered UI, not server-rendered HTML per request |

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
- static assets served from `public/`

A new slash command `.claude/commands/dashboard.md` replaces `.claude/commands/html-report.md`. It:
- Starts the Bun server in the background (`bun dashboard/src/server.ts`), default port `4173`, overridable via an argument
- Opens the browser (`open http://localhost:PORT` on macOS) and prints the URL regardless, in case auto-open fails or the platform differs
- On port-in-use, surfaces the server's error to the user rather than silently picking another port

This ports the data/stat logic that currently exists only as *prose instructions* in `.claude/commands/html-report.md` (read by Claude fresh on every run) into real, testable TypeScript that runs deterministically as a server.

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

## Testing

- `dashboard/src/data.test.ts` (`bun test`): unit tests for CSV parsing, status normalization (including legacy space-spelling tolerance and unrecognized-value bucketing), funnel/rejection-rate math, and `outcome.md` fuzzy-matching. These pin the behavioral guarantees that today live only as prose in `html-report.md`.
- A slim Python structural test (mirroring the pattern in `tests/test_html_report_command.py`) asserting `.claude/commands/dashboard.md` exists and documents the right invocation.
- No e2e/browser test framework. Manual click-through (start server, open browser, exercise filters and refresh) is the acceptance check for client rendering — consistent with a personal-scale tool.

## Migration

- Retire `.claude/commands/html-report.md`.
- Retire or rewrite `tests/test_html_report_command.py` to instead test `.claude/commands/dashboard.md`'s structural properties.
- No changes to `job_search_tracker.csv`, `documents/applications/`, or any other command — the dashboard is read-only.

## Out of scope (this spec)

- **Operate phase**: triggering `/apply`, `/rank`, `/scrape` from the GUI, with subprocess output streamed to the browser (e.g. via SSE). Deferred to a follow-up spec once the dashboard ships. The API/client split in this design exists specifically so that phase can be added as new routes (`POST /api/apply`, etc.) without restructuring what's built here.
- Authentication/access control — binds to localhost only, single local user.
- Auto-refresh / live file watching — explicitly rejected in favor of a manual refresh button.
- Editing tracker data from the GUI — the dashboard is read-only; the tracker stays the system of record, written only by `/apply` and `/outcome`.
