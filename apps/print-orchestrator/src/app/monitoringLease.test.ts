import assert from "node:assert/strict";
import { test } from "node:test";

import { MONITORING_LEASE_TTL_MS, MonitoringLease } from "./monitoringLease";

/* The farm-wide "operator is watching" lease on an injected clock. */

function lease(startMs = 0) {
  let nowMs = startMs;
  const instance = new MonitoringLease(MONITORING_LEASE_TTL_MS, () => nowMs);
  return { instance, advance: (ms: number) => { nowMs += ms; } };
}

test("a fresh lease is inactive until renewed, then expires by itself", () => {
  const { instance, advance } = lease();
  assert.equal(instance.isActive(), false, "nothing granted yet");
  assert.equal(instance.expiresAt(), null);

  instance.renew();
  assert.equal(instance.isActive(), true);

  advance(MONITORING_LEASE_TTL_MS - 1);
  assert.equal(instance.isActive(), true, "still inside the TTL");

  advance(2);
  assert.equal(instance.isActive(), false, "expired without any release call");
  assert.equal(instance.expiresAt(), null);
});

test("renewals are idempotent extensions: each one just moves the expiry forward", () => {
  const { instance, advance } = lease();

  const first = instance.renew();
  advance(30 * 1000);
  const second = instance.renew();
  assert.equal(
    second.expiresAt.getTime() - first.expiresAt.getTime(),
    30 * 1000,
    "the second renewal extended the lease by the elapsed time"
  );

  // Two renewals 30 s apart keep the lease alive well past the first TTL.
  advance(MONITORING_LEASE_TTL_MS - 1000);
  assert.equal(instance.isActive(), true);
  advance(2000);
  assert.equal(instance.isActive(), false);
});

test("the TTL stays within the agreed 60–90 s monitoring bound", () => {
  assert.ok(MONITORING_LEASE_TTL_MS >= 60 * 1000 && MONITORING_LEASE_TTL_MS <= 90 * 1000);
});
