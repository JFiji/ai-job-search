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
