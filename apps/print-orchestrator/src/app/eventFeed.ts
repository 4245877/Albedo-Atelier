import type { FeedEvent, FeedKind } from "../domain/dashboard/types";
import { hhmm } from "../shared/time";

/**
 * The feed keeps at most this many events — one number for the runtime bound,
 * what gets persisted, and what a loaded state file is trimmed to (the state
 * normalizer imports it), so the three can never drift apart.
 */
export const MAX_FEED = 50;

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
