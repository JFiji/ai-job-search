import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as BunServer } from "bun";
type Server = BunServer<undefined>;
import { createFetchHandler, resolveStaticAssetPath } from "../src/server";
import { ApplyJobManager } from "../src/apply";

// Minimal Server stand-in - real handlers receive `(req, server)` from
// Bun.serve, but nothing in these tests needs a live server beyond
// recording `.timeout()` calls for the idle-timeout regression test below.
function fakeServer(): { server: Server; timeoutCalls: Array<[Request, number]> } {
  const timeoutCalls: Array<[Request, number]> = [];
  const server = { timeout: (req: Request, seconds: number) => { timeoutCalls.push([req, seconds]); } } as unknown as Server;
  return { server, timeoutCalls };
}

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
    const res = await handler(new Request("http://localhost/api/data"), fakeServer().server);
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
      fakeServer().server,
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
      fakeServer().server,
    );
    expect(first.status).toBe(202);
    const second = await handler(
      new Request("http://localhost/api/apply", {
        method: "POST",
        body: JSON.stringify({ input: "https://example.com/other" }),
      }),
      fakeServer().server,
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
      fakeServer().server,
    );
    expect(res.status).toBe(500);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET /api/apply/:id/events for an unknown job returns an SSE error event", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/api/apply/does-not-exist/events"), fakeServer().server);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: error");
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET /api/apply/:id/events disables Bun's default idle timeout for this request", async () => {
    // Regression test for a real bug found live: Bun.serve's default
    // idleTimeout is 10 seconds, and a real /apply run can sit with no SSE
    // data flowing for far longer than that while the subprocess works -
    // without this, Bun silently kills the connection before any event
    // ever arrives, indistinguishable from the server sending nothing.
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const { server, timeoutCalls } = fakeServer();
    const req = new Request("http://localhost/api/apply/does-not-exist/events");
    await handler(req, server);
    expect(timeoutCalls).toEqual([[req, 0]]);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET /api/data does not touch the idle timeout - only the SSE route needs it disabled", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const { server, timeoutCalls } = fakeServer();
    await handler(new Request("http://localhost/api/data"), server);
    expect(timeoutCalls).toEqual([]);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("GET / serves index.html", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/"), fakeServer().server);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html>");
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("rejects path traversal attempts on static assets", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/../../job_search_tracker.csv"), fakeServer().server);
    expect(res.status).toBe(404);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("unknown path returns 404", async () => {
    const repoRoot = makeRepoFixture();
    const handler = createFetchHandler(repoRoot, new ApplyJobManager(), join(repoRoot, "public"));
    const res = await handler(new Request("http://localhost/nope"), fakeServer().server);
    expect(res.status).toBe(404);
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("resolveStaticAssetPath", () => {
  // These drive raw strings containing literal ".." directly into the guard,
  // bypassing WHATWG URL normalization (which strips ".."/"%2e%2e" from
  // `url.pathname` before an HTTP-level test could ever exercise this path).
  test("rejects a raw traversal string escaping publicDir", () => {
    const repoRoot = makeRepoFixture();
    const publicDir = join(repoRoot, "public");
    expect(resolveStaticAssetPath(publicDir, "../../job_search_tracker.csv")).toBeNull();
    expect(resolveStaticAssetPath(publicDir, "/../../etc/passwd")).toBeNull();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("rejects a sibling directory sharing publicDir's name as a prefix", () => {
    const repoRoot = makeRepoFixture();
    const publicDir = join(repoRoot, "public");
    // Would incorrectly pass a bare `startsWith(resolvedPublicDir)` check,
    // since "/repo/public-evil" starts with the string "/repo/public".
    mkdirSync(join(repoRoot, "public-evil"), { recursive: true });
    writeFileSync(join(repoRoot, "public-evil", "secret"), "top secret");
    expect(resolveStaticAssetPath(publicDir, "../public-evil/secret")).toBeNull();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("accepts a path that legitimately resolves inside publicDir", () => {
    const repoRoot = makeRepoFixture();
    const publicDir = join(repoRoot, "public");
    const resolved = resolveStaticAssetPath(publicDir, "/index.html");
    expect(resolved).toBe(join(publicDir, "index.html"));
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
