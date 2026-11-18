import { readGameMode, subscribeGameMode } from "@/lib/game-mode/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (view: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
        } catch {
          // The browser closed the stream.
        }
      };
      send(readGameMode());
      unsubscribe = subscribeGameMode(send);
    },
    cancel() {
      unsubscribe();
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
