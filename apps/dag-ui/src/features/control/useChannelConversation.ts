import type { ChannelQueue } from "@onepipeline-ui/dag-model";
import { useMemo } from "react";

/** The producer's correlations group answers; consuming a question does not answer it. */
export function useChannelConversation(queue: ChannelQueue) {
  return useMemo(() => {
    const correlations = new Set(
      queue.surfaces.flatMap((surface) =>
        surface.correlation ? [surface.correlation] : [],
      ),
    );
    const exchanges = [...queue.surfaces].reverse().map((surface) => ({
      surface,
      replies: queue.replies.filter(
        (reply) =>
          surface.correlation !== undefined &&
          reply.correlation === surface.correlation,
      ),
    }));
    const otherReplies = queue.replies.filter(
      (reply) => !correlations.has(reply.correlation ?? ""),
    );
    return { exchanges, otherReplies };
  }, [queue]);
}
