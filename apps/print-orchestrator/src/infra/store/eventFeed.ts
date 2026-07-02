import type { FeedEvent, FeedKind } from "../../domain/dashboard/types";
import { hhmm } from "../../shared/time";

const MAX_FEED = 50;

/**
 * The live event feed — real transitions the poller observed and operator
 * actions. In memory, newest first, bounded so it never grows without limit.
 */
export class EventFeed {
  private feed: FeedEvent[] = [];

  push(icon: string, text: string, kind: FeedKind): void {
    this.feed.unshift({ icon, text, time: hhmm(), kind });
    if (this.feed.length > MAX_FEED) {
      this.feed.length = MAX_FEED;
    }
  }

  list(): FeedEvent[] {
    return [...this.feed];
  }
}
