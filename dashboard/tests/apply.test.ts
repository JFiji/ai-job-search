import { describe, expect, test } from "bun:test";
import { ApplyJobManager, buildApplyCommand, type SpawnFn } from "../src/apply";

function fakeStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
}

describe("buildApplyCommand", () => {
  test("returns array-form arguments, never a shell string", () => {
    const cmd = buildApplyCommand("https://example.com/job posting with spaces");
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd).toEqual(["claude", "-p", "/apply https://example.com/job posting with spaces"]);
  });
});

describe("ApplyJobManager", () => {
  test("streams stdout lines and emits done on exit code 0", async () => {
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream(["evaluating fit", "drafting CV"]),
      stderr: fakeStream([]),
      exited,
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const result = manager.start("https://example.com/job");
    expect("jobId" in result).toBe(true);
    const jobId = (result as { jobId: string }).jobId;

    const events: { type: string; data: string }[] = [];
    const done = new Promise<void>((resolveDone) => {
      manager.subscribe(jobId, (event) => {
        events.push(event);
        if (event.type !== "message") resolveDone();
      });
    });
    resolveExited(0);
    await done;

    expect(events.some((e) => e.data === "evaluating fit")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("emits error when the process exits non-zero", async () => {
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: Promise.resolve(1),
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const { jobId } = manager.start("https://example.com/job") as { jobId: string };
    const event = await new Promise<{ type: string; data: string }>((resolve) => {
      manager.subscribe(jobId, (e) => { if (e.type !== "message") resolve(e); });
    });
    expect(event.type).toBe("error");
  });

  test("rejects a second concurrent apply with an error, not a crash", () => {
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: new Promise(() => {}),
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const first = manager.start("https://example.com/job-a");
    const second = manager.start("https://example.com/job-b");
    expect("jobId" in first).toBe(true);
    expect("error" in second).toBe(true);
    expect(manager.isRunning()).toBe(true);
  });

  test("kills the process and emits a timeout error after the timeout elapses", async () => {
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: new Promise(() => {}),
      kill: () => { killed = true; },
    });
    const manager = new ApplyJobManager(spawnFn, 20);
    const { jobId } = manager.start("https://example.com/job") as { jobId: string };
    const event = await new Promise<{ type: string; data: string }>((resolve) => {
      manager.subscribe(jobId, (e) => { if (e.type !== "message") resolve(e); });
    });
    expect(event.type).toBe("error");
    expect(event.data.toLowerCase()).toContain("timed out");
    expect(killed).toBe(true);
  });

  test("subscribe returns null for an unknown job id", () => {
    const manager = new ApplyJobManager();
    expect(manager.subscribe("no-such-job", () => {})).toBeNull();
  });

  test("returns an error instead of throwing when spawning fails synchronously (e.g. claude CLI missing)", () => {
    const spawnFn: SpawnFn = () => { throw new Error("spawn claude ENOENT"); };
    const manager = new ApplyJobManager(spawnFn, 1000);
    const result = manager.start("https://example.com/job");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("ENOENT");
    expect(manager.isRunning()).toBe(false);
  });

  test("delivers the buffered terminal event to a subscriber that arrives after the job already finished", async () => {
    // Regression test for a real race: POST /api/apply returns 202 with the
    // jobId, the client then opens an EventSource, and if the subprocess
    // finishes in that window (e.g. a fast CLI-auth failure), the terminal
    // event would already have fired to zero listeners - a late subscribe()
    // must not just register a listener that never fires again.
    const spawnFn: SpawnFn = () => ({
      stdout: fakeStream([]),
      stderr: fakeStream([]),
      exited: Promise.resolve(0),
      kill: () => {},
    });
    const manager = new ApplyJobManager(spawnFn, 1000);
    const { jobId } = manager.start("https://example.com/job") as { jobId: string };

    // Let pump() run to completion and emit "done" with zero subscribers.
    await new Promise((r) => setTimeout(r, 10));

    const event = await new Promise<{ type: string; data: string }>((resolve) => {
      const unsubscribe = manager.subscribe(jobId, (e) => resolve(e));
      expect(unsubscribe).not.toBeNull();
    });
    expect(event.type).toBe("done");
  });
});
