import { resolve, join } from "node:path";
import { loadDashboardData } from "./data";
import { ApplyJobManager, type ApplyEvent } from "./apply";

export function createFetchHandler(
  repoRoot: string,
  jobs: ApplyJobManager,
  publicDir: string,
): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/data" && req.method === "GET") {
      const data = await loadDashboardData(repoRoot);
      return Response.json(data);
    }

    if (url.pathname === "/api/apply" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const input = typeof (body as { input?: unknown } | null)?.input === "string"
        ? (body as { input: string }).input.trim()
        : "";
      if (!input) return Response.json({ error: "input is required" }, { status: 400 });
      const result = jobs.start(input);
      if ("error" in result) {
        // A result with a jobId means an apply is already running (409 conflict);
        // no jobId means the subprocess itself failed to start (500).
        return Response.json(result, { status: "jobId" in result ? 409 : 500 });
      }
      return Response.json(result, { status: 202 });
    }

    const eventsMatch = url.pathname.match(/^\/api\/apply\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const jobId = eventsMatch[1];
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: ApplyEvent) => {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${event.data}\n\n`));
            if (event.type !== "message") controller.close();
          };
          unsubscribe = jobs.subscribe(jobId, send);
          if (!unsubscribe) {
            controller.enqueue(encoder.encode(`event: error\ndata: unknown job\n\n`));
            controller.close();
          }
        },
        cancel() {
          unsubscribe?.();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolvedPublicDir = resolve(publicDir);
    const assetPath = resolve(join(publicDir, requestedPath));
    if (!assetPath.startsWith(resolvedPublicDir)) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(assetPath);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  };
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const publicDir = resolve(import.meta.dir, "..", "public");
  const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
  const jobs = new ApplyJobManager();
  const server = Bun.serve({ port, fetch: createFetchHandler(repoRoot, jobs, publicDir) });
  console.log(`Dashboard running at http://localhost:${server.port}`);
}
