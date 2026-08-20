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

export function buildApplyCommand(input: string): string[] {
  return ["claude", "-p", `/apply ${input}`];
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
      timeoutHandle: setTimeout(() => this.timeoutJob(job), this.timeoutMs),
    };
    this.current = job;
    void this.pump(job);
    return { jobId: id };
  }

  subscribe(jobId: JobId, listener: (event: ApplyEvent) => void): (() => void) | null {
    if (!this.current || this.current.id !== jobId) return null;
    const job = this.current;
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
    for (const listener of job.listeners) listener(event);
  }
}
