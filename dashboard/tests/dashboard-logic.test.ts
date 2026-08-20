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
