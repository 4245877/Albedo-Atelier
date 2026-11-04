import assert from "node:assert/strict";
import { test } from "node:test";
import { createChangeBus, isSectionVisible, mutationResources } from "../shared/changes.js";

test("mutations invalidate related resources; monitoring leases and lights do not refetch printing data", () => {
  assert.ok(mutationResources("/api/print/artifacts/a?cascade=true").includes("artifacts"));
  assert.ok(mutationResources("/api/print/operations/o/complete").includes("printers"));
  assert.ok(mutationResources("/api/printers/k2/bed/clear").includes("tasks"));
  assert.deepEqual(mutationResources("/api/monitoring/lease"), []);
  assert.deepEqual(mutationResources("/api/printers/k2/light"), []);
});

test("local subscribers receive only relevant changes and can unsubscribe", () => {
  const bus = createChangeBus();
  const received = [];
  const off = bus.subscribe(["artifacts"], (change) => received.push(change));
  bus.publish("/api/print/artifacts/a", "DELETE");
  bus.publish("/api/print/operations/o/complete", "POST");
  off();
  bus.publish("/api/print/artifacts/b", "DELETE");
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "DELETE");
});

test("a change crosses browser tabs once, without a broadcast loop", () => {
  const channels = [];
  let broadcasts = 0;
  const openChannel = () => {
    const channel = { close() {}, postMessage(data) {
      broadcasts++;
      for (const peer of channels) if (peer !== channel) peer.onmessage({ data });
    } };
    channels.push(channel);
    return channel;
  };
  const a = createChangeBus({ openChannel });
  const b = createChangeBus({ openChannel });
  const received = [];
  b.subscribe(["printers"], (change) => received.push(change));
  a.publish("/api/printers/k2/bed/clear", "POST");
  assert.equal(broadcasts, 1);
  assert.equal(received.length, 1);
  a.close(); b.close();
});

test("unavailable cross-tab messaging leaves local synchronization working", () => {
  const bus = createChangeBus({ openChannel() { throw new Error("disabled"); } });
  let count = 0;
  bus.subscribe(["tasks"], () => { count++; });
  bus.publish("/api/print/tasks/t/enqueue", "POST");
  assert.equal(count, 1);
});

test("visibility accounts for a hidden parent mode and the browser tab", () => {
  const originalDocument = globalThis.document;
  let hiddenParent = false;
  const section = { closest: () => hiddenParent ? {} : null };
  globalThis.document = { hidden: false, getElementById: () => section };
  try {
    assert.equal(isSectionVisible("newprint"), true);
    hiddenParent = true;
    assert.equal(isSectionVisible("newprint"), false);
    hiddenParent = false;
    document.hidden = true;
    assert.equal(isSectionVisible("newprint"), false);
  } finally {
    globalThis.document = originalDocument;
  }
});
