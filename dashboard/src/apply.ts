export type JobId = string;

export interface ApplyEvent {
  type: "message" | "done" | "error";
  data: string;
}

export type SpawnFn = (cmd: string[]) => {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Headless `claude -p` runs have no human to approve permission prompts, so
// every tool call is silently denied unless explicitly granted here - /apply
// would otherwise "succeed" (exit 0) without ever fetching or writing
// anything, for every job, every time.
//
// Must be a single `--allowedTools=<value>` token (`=`, not a following
// argv element) - the flag is variadic and a separate next token gets
// consumed as more tool names, swallowing the prompt argument that comes
// after it. Verified against the real CLI.
const ALLOWED_TOOLS = "WebFetch,WebSearch,Read,Write,Edit,Glob,Grep,Agent,Bash";

export function buildApplyCommand(input: string): string[] {
  return ["claude", "-p", `--allowedTools=${ALLOWED_TOOLS}`, `/apply ${input}`];
}

function defaultSpawn(cmd: string[]): ReturnType<SpawnFn> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
}

interface RunningJob {
  id: JobId;
  proc: ReturnType<SpawnFn>;
  listeners: Set<(event: ApplyEvent) => void>;
  timeoutHandle: ReturnType<typeof setTimeout>;
  finished: boolean;
  // Every event emitted so far, in order - not just the terminal one.
  // `claude -p`'s stdout is fully block-buffered when piped to a non-TTY,
  // so many/all "message" lines can fire in one synchronous burst well
  // before a subscriber's HTTP round-trip completes (subscribing is
  // necessarily a second request after POST /api/apply's response).
  // Buffering only the terminal event left every message emitted before
  // that race lost - a subscriber connecting even slightly late saw
  // nothing at all for the entire run.
  history: ApplyEvent[];
}

export class ApplyJobManager {
  private current: RunningJob | null = null;

  constructor(
    private readonly spawnFn: SpawnFn = defaultSpawn,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  start(input: string): { jobId: JobId } | { error: string; jobId?: JobId } {
    if (this.current && !this.current.finished) {
      return { error: "An apply run is already in progress", jobId: this.current.id };
    }
    const id = crypto.randomUUID();
    let proc: ReturnType<SpawnFn>;
    try {
      proc = this.spawnFn(buildApplyCommand(input));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const job: RunningJob = {
      id,
      proc,
      listeners: new Set(),
      finished: false,
      history: [],
      timeoutHandle: setTimeout(() => this.timeoutJob(job), this.timeoutMs),
    };
    this.current = job;
    void this.pump(job);
    return { jobId: id };
  }

  subscribe(jobId: JobId, listener: (event: ApplyEvent) => void): (() => void) | null {
    if (!this.current || this.current.id !== jobId) return null;
    const job = this.current;
    // Replay everything that already happened before this subscriber
    // connected - subscribing is necessarily a second HTTP round-trip after
    // POST /api/apply's response, so some (occasionally all, given
    // `claude -p`'s block-buffered stdout) output can already have fired to
    // zero listeners by the time this call arrives.
    for (const event of job.history) listener(event);
    if (job.finished) return () => {};
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  isRunning(): boolean {
    return this.current !== null && !this.current.finished;
  }

  private async pump(job: RunningJob): Promise<void> {
    const readLines = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          this.emit(job, { type: "message", data: buf.slice(0, idx) });
          buf = buf.slice(idx + 1);
        }
      }
      if (buf) this.emit(job, { type: "message", data: buf });
    };

    await Promise.all([readLines(job.proc.stdout), readLines(job.proc.stderr)]);
    const exitCode = await job.proc.exited;
    if (job.finished) return; // already timed out
    clearTimeout(job.timeoutHandle);
    job.finished = true;
    if (exitCode === 0) {
      this.emit(job, { type: "done", data: "" });
    } else {
      this.emit(job, { type: "error", data: `claude exited with code ${exitCode}` });
    }
  }

  private timeoutJob(job: RunningJob): void {
    if (job.finished) return;
    job.finished = true;
    job.proc.kill();
    this.emit(job, { type: "error", data: "Apply run timed out" });
  }

  private emit(job: RunningJob, event: ApplyEvent): void {
    job.history.push(event);
    for (const listener of job.listeners) listener(event);
  }
}
