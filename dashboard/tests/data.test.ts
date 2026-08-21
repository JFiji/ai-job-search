import { describe, expect, test } from "bun:test";
import { parseCsv, parseTrackerCsv, normalizeStatus } from "../src/data";

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

  test("flags the archive-only status interview_only as unrecognized (it's not a tracker status)", () => {
    expect(normalizeStatus("interview_only").unrecognized).toBe(true);
  });
});

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
  test("excludes Drafted rows from total, funnel, and rejectionRate (but not sector/channel - see next test)", () => {
    const rows = [row({ bucket: "Drafted", status: "drafted" }), row({ bucket: "Active", status: "applied" })];
    const stats = computeStats(rows);
    expect(stats.total).toBe(1);
    expect(stats.draftedCount).toBe(1);
    expect(stats.byBucket.Drafted).toBe(1);
    expect(stats.byBucket.Active).toBe(1);
  });

  test("computes sector and channel breakdowns from every row regardless of status, but year only from submitted rows", () => {
    // Sector/channel intentionally include Drafted rows - "what am I even
    // working on" is meaningful before formal submission, unlike the
    // funnel/rejection-rate stats below (which require an actual "applied"
    // baseline and stay submitted-only).
    const rows = [
      row({ bucket: "Drafted", status: "drafted", sector: "Government", channel: "email", date: "2024" }),
      row({ bucket: "Active", status: "applied", sector: "Tech", channel: "portal", date: "2026-03-15" }),
      row({ bucket: "Interview", status: "interview", sector: "Finance", channel: "referral", date: "2025" }),
    ];
    const stats = computeStats(rows);
    expect(stats.bySector).toEqual({ Government: 1, Tech: 1, Finance: 1 });
    expect(stats.byChannel).toEqual({ email: 1, portal: 1, referral: 1 });
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
