---
name: tailor-documents
description: >
  Phase 2 of the job pipeline: drafts, verifies, and compiles a tailored CV and cover letter for
  a specific role, then inspects the compiled PDFs. Triggers on: CV, resume, cover letter, tailor
  CV, tailor cover letter, write CV, write cover letter, write a resume, /add-template
allowed-tools: Read, Glob, Grep, WebFetch, WebSearch, Bash, Edit, Write
framework_version: 1.4.0
---

# Tailor Documents

This is **phase 2 of a three-phase pipeline** (search-and-rank → tailor-documents → apply). Each
phase is an independent skill: `search-and-rank` finds and ranks postings, this one produces the
CV and cover letter, and `apply` submits and records. This skill runs on its own — it does **not**
invoke `search-and-rank` or `apply`. Producing a tailored CV or cover letter is a complete task in
itself; recording an application is a separate phase the `apply` skill owns.

**Disjoint write target (concurrency safety).** This skill writes **only** to
`cv/main_<company>_<role>.tex` and `cover_letters/cover_<company>_<role>.tex` (and their compiled
`.pdf` output, plus a transient `.txt`/build artifact it deletes). It never touches
`job_scraper/seen_jobs.json`, `job_search_tracker.csv`, or `documents/applications/` — those belong
to the other two phases — so it can run concurrently with them without clobbering shared state. The
shared reference docs it reads (under `.claude/skills/job-application-assistant/`) are read-only.

---

## What this skill owns

Producing **and** verifying the two application documents:

1. Drafting a role-tailored CV (`cv/main_<company>_<role>.tex`) and cover letter
   (`cover_letters/cover_<company>_<role>.tex`) from the candidate profile.
2. Compiling both to PDF and visually inspecting the compiled output (mandatory).
3. Running the ATS / keyword verification on the CV's extracted text layer.

It does not submit the application or write the tracker — hand off to the `apply` skill for that.

## Invocation

The user triggers this skill by saying things like:
- "Tailor my CV for the <role> at <company>"
- "Write a cover letter for this posting"
- "Draft a resume for this job"
- "/add-template" (to register a custom CV/cover-letter template first)

If the posting is not already in context, ask the user for the posting URL or text (or the drafted
evaluation), then proceed. This skill can start from a posting alone; it does not require a prior
`search-and-rank` run.

---

## Reference files (read-only shared core)

Read these from `.claude/skills/job-application-assistant/` as needed — do not duplicate their content:

| File | Purpose |
|------|---------|
| `01-candidate-profile.md` | The factual source of truth for every claim (with the master CV and CLAUDE.md) |
| `03-writing-style.md` | Tone, structure, do's and don'ts (no em-dashes, no cliches) |
| `05-cv-templates.md` | LaTeX CV structure, tailoring rules, relevance-weighted cutting |
| `06-cover-letter-templates.md` | LaTeX cover letter structure and tailoring rules |
| `08-application-forms.md` | Portal free-text fields (optional third artifact) |

Plus the templates themselves: existing `cv/main_*.tex` and `cover_letters/cover_*.tex` as
structural references (never as a source of claims), and the stock `cv/main_example.tex` /
`cover_letters/cover_example.tex`.

---

## Drafting + verification workflow

This skill reuses the drafting and **mandatory compile-and-inspect** steps that live in
`/apply` Steps 2–5 (`.claude/commands/apply.md`) and in `05-cv-templates.md` /
`06-cover-letter-templates.md`. Follow those, do not restate them. In outline:

### 1. Resolve the active template (once)
If `05-cv-templates.md` or `06-cover-letter-templates.md` opens with an `ACTIVE-TEMPLATE` managed
block (inserted by `/add-template`), read its declared **source extension** and **compile command**
— these override the stock `.tex`/lualatex (CV) and `.tex`/xelatex (cover letter) defaults for the
rest of the workflow. See `/apply` Step 2 for the `<CV_EXT>`/`<CV_COMPILE>`/`<COVER_EXT>`/
`<COVER_COMPILE>` resolution rules.

### 2. Draft the CV and cover letter
Follow `/apply` Step 2:
- CV in the **CV language from the profile** (CLAUDE.md's `CV language:` line; default English),
  moderncv/banking format per `05-cv-templates.md`, tailored profile statement and experience
  bullets, 2 pages.
- Cover letter in the **language of the posting**, `cover.cls` structure per
  `06-cover-letter-templates.md`, one page, addressed to a named person or "Dear Hiring Manager".
- **Requirement coverage:** every requirement the posting states gets addressed — matched or
  honestly gapped, never silently omitted. Engage nice-to-haves by name where the profile supports
  honest adjacency, and prefer the posting's exact term over a synonym where truthfully applicable.
- **Grounding Audit (mandatory):** before writing to disk, audit every tailored claim against the
  union of `01-candidate-profile.md` + the master CV (`cv/main_example.tex`) + CLAUDE.md's
  Candidate Profile section. Zero fabrication, zero profile drift. A genuine gap is acknowledged
  and reframed, never invented.
- Any mention of agentic coding or AI tooling must reference **Claude Code** by name.

### 3. Compile & inspect PDFs (MANDATORY — never skip)
Follow `/apply` Step 5. "Looks fine in the .tex" is not acceptable — LaTeX page-break decisions are
unpredictable. Compile with the resolved commands (stock: **lualatex** for the CV, **xelatex** for
the cover letter), then Read both PDFs and verify:
- CV is **exactly 2 pages**, with no orphaned `\cventry` titles and no isolated section headings.
- Cover letter is **exactly 1 page**, signature block visible, bullet font matching the body.
- Iterate on the source and recompile until both pass (see `05`/`06` for the standard fixes:
  `\needspace`, `\enlargethispage`, the itemize/`\lettercontent` pattern, relevance-weighted cutting).

### 4. ATS & keyword verification (CV)
Follow `/apply` Step 5d: extract the CV's text layer with `pdftotext -layout` (graceful skip with a
warning if poppler is missing), confirm it extracts cleanly with email/phone as literal text and
correct reading order, and check posting-keyword coverage — tightening synonym-only matches to the
posting's exact term where truthfully applicable, adding keywords the profile genuinely supports,
and leaving genuine gaps visible. **Never stuff keywords.** Delete the extracted `.txt` afterward.

### 5. Clean up build artifacts
After the final clean compile, delete intermediate `.aux`/`.log`/`.out` files. Keep the source and
the `.pdf`.

### 6. Optional third artifact — application-form fields
If the posting or its portal asks for free-text fields the CV and cover letter don't cover (a
self-introduction paragraph, structured project entries, a character-limited pitch), offer to draft
them per `08-application-forms.md`, grounded against the same three-source union. Only on the user's
yes.

---

## Handoff

When both documents pass inspection, tell the user they are ready and point them at the next phase:
> "The tailored CV and cover letter are ready. To record and submit this application, use the
> `apply` skill (`/apply`) — it operates on these drafted files on disk."

Do not record the application, write the tracker, or archive the posting yourself — the `apply`
skill owns that, and keeping the write targets disjoint is what lets the phases run concurrently.

---

## Important Rules

1. **Facts come only from the sources.** `01-candidate-profile.md`, the master CV, and CLAUDE.md's
   Candidate Profile section are the sole source of claims. Existing tailored CVs may be read for
   structure and phrasing only, never as a source of facts.
2. **Never fabricate.** A posting requirement the candidate lacks is acknowledged honestly and
   framed via adjacent experience, never invented.
3. **The compile-and-inspect step is non-negotiable.** Both PDFs must be compiled and visually read
   before the documents are presented.
4. **Claude Code by name.** Any agentic-coding / AI-tooling reference names Claude Code explicitly.
5. **Stay in your lane.** This skill produces documents; it never submits an application, writes
   `job_search_tracker.csv`, or edits `job_scraper/seen_jobs.json`.
