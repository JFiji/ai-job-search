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
