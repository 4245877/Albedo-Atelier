import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameFreshness } from "../render/cameraFreshness.js";

/*
 * The honest-LIVE contract: LIVE means frames actually advanced recently;
 * a track that exists but stopped delivering frames is STALE, not LIVE;
 * no track at all is OFFLINE.
 */

test("advancing frames → live; a stopped-but-present track degrades to stale", () => {
  const f = new FrameFreshness({ staleMs: 4000 });
  let now = 0;

  f.sample(now, 10);
  assert.equal(f.classify(now, true), "live", "first frames seen → live");

  now += 1000;
  f.sample(now, 20);
  assert.equal(f.classify(now, true), "live", "frames advanced → still live");

  // The stream freezes: the track stays, the frame counter stops.
  for (let i = 0; i < 5; i++) {
    now += 1000;
    f.sample(now, 20);
  }
  assert.equal(
    f.classify(now, true),
    "stale",
    "track exists but no new frames for > staleMs → STALE, not LIVE"
  );

  // Frames resume → live again.
  now += 1000;
  f.sample(now, 21);
  assert.equal(f.classify(now, true), "live");
});

test("no track → offline regardless of history", () => {
  const f = new FrameFreshness({ staleMs: 4000 });
  f.sample(0, 100);
  assert.equal(f.classify(500, false), "offline");
});

test("a track with NO frames ever seen is stale (never optimistically live)", () => {
  const f = new FrameFreshness({ staleMs: 4000 });
  assert.equal(f.classify(0, true), "stale");
});

test("a counter reset (reconnect mints a new decoder) counts as advancement", () => {
  const f = new FrameFreshness({ staleMs: 4000 });
  f.sample(0, 500);
  f.sample(6000, 500); // frozen past the threshold
  assert.equal(f.classify(6000, true), "stale");
  f.sample(7000, 3); // new connection: counter restarted
  assert.equal(f.classify(7000, true), "live");
});

test("reset() forgets history (element torn down and rebuilt)", () => {
  const f = new FrameFreshness({ staleMs: 4000 });
  f.sample(0, 10);
  f.reset();
  assert.equal(f.classify(1, true), "stale");
});
