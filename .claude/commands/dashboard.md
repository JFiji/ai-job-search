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
