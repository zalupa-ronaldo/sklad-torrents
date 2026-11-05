import { formatSse, snapshotEvent } from "@/lib/jobs/http";
import { ensureJobWorkers } from "@/lib/jobs/runtime";
import { getJobStore } from "@/lib/jobs/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  ensureJobWorkers();
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The browser closed the stream.
        }
      };
      send(": ok\n\n");
      unsubscribe = getJobStore().subscribe((event) => send(formatSse(event)));
      void snapshotEvent().then((event) => send(formatSse(event)));
      heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
