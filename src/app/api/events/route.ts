// src/app/api/events/route.ts
// Server-Sent Events stream of the in-process event bus (src/lib/events/bus.ts). Sends the existing
// backlog first (everything after `?after=<seq>`, or the last 100 events if omitted), then streams
// new events live as they're emitted elsewhere in the process (chaos actions, repair/scrub/rebalance,
// autopilot cycles, reads, writes). This is what the dashboard's live feed panel subscribes to.
import { NextRequest } from "next/server";
import { recentEvents, subscribe, type VaultEvent } from "@/lib/events/bus";

export const dynamic = "force-dynamic";

function frame(event: VaultEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(req: NextRequest) {
  const afterParam = req.nextUrl.searchParams.get("after");
  const parsedAfter = afterParam ? Number.parseInt(afterParam, 10) : 0;
  const after = Number.isFinite(parsedAfter) ? parsedAfter : 0;
  const backlog = recentEvents(100, after);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      for (const event of backlog) {
        controller.enqueue(encoder.encode(frame(event)));
      }

      unsubscribe = subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(frame(event)));
        } catch {
          // Stream already closed on the way out; the abort handler below will clean up.
        }
      });

      // Browsers and proxies can drop an idle connection; a periodic comment line keeps it open.
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
        }
      }, 20_000);

      req.signal.addEventListener("abort", () => {
        if (keepAlive) clearInterval(keepAlive);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}