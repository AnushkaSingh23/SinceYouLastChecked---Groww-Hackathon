import { marketFeedStore } from "@/lib/marketFeedStore";
import { getNSEMarketStatus } from "@/lib/marketHours";
import type { NSEQuote } from "@/lib/marketData";

function toSSE(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  marketFeedStore.ensureStarted();

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (quotes: NSEQuote[]) => {
        controller.enqueue(
          encoder.encode(
            toSSE("update", {
              marketStatus: getNSEMarketStatus(),
              lastPollAt: marketFeedStore.getLastPollAt(),
              quotes,
            })
          )
        );
      };

      // Send whatever we already have immediately, then push on every poll.
      send(marketFeedStore.getSnapshot());
      unsubscribe = marketFeedStore.subscribe(send);

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        controller.close();
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
