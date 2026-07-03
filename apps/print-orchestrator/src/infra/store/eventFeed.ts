import type { FeedEvent, FeedKind } from "../../domain/dashboard/types";
import { hhmm } from "../../shared/time";

const MAX_FEED = 50;

/**
 * The live event feed — real transitions the poller observed and operator
 * actions. Newest first, bounded so it never grows without limit. Hydrated from
 * persisted state on start and persisted again on every push so the feed
 * survives a restart.
 */
export class EventFeed {
  private feed: FeedEvent[];

  constructor(
    initial: FeedEvent[] = [],
    private readonly persist: () => void = () => {}
  ) {
    this.feed = initial.slice(0, MAX_FEED);
  }

  push(icon: string, text: string, kind: FeedKind): void {
    this.feed.unshift({ icon, text, time: hhmm(), kind });
    if (this.feed.length > MAX_FEED) {
      this.feed.length = MAX_FEED;
    }
    this.persist();
  }

  list(): FeedEvent[] {
    return [...this.feed];
  }
}
