/* ═══════════════════════════════════════════════════════════════
   Immutable edit snapshots for optimistic-locking forms.

   The bug this closes: a form opened at version v1 kept its FIELD
   values from v1, while background polling refreshed the global
   state to v2 — submit then read `expectedVersion` from the fresh
   state (v2) and pushed stale v1 data as if it were based on v2,
   silently clobbering the other operator's change.

   The rule now: everything the submit sends — including
   `expectedVersion` — comes from the snapshot taken when the form
   was OPENED. Polling may update the global state freely; it can
   only mark the form stale (banner), never rewrite its identity.
   A stale submit therefore reaches the server with the old version
   and gets an honest 409; re-reading the form mints a NEW snapshot.
   Pure module, no DOM — unit-testable in Node.
   ═══════════════════════════════════════════════════════════════ */

/** Snapshot of the task the operator STARTED editing (immutable). */
export function createSnapshot(task) {
  return Object.freeze({
    taskId: task.id,
    version: task.version,
    openedAt: Date.now()
  });
}

/**
 * True when the current (poll-refreshed) task version no longer matches the
 * snapshot the open form was built from — the form is stale and the UI must
 * say so. A missing current task (deleted/dispatched) is also stale.
 */
export function isSnapshotStale(snapshot, currentTask) {
  if (!snapshot) return false;
  if (!currentTask) return true;
  return currentTask.version !== snapshot.version;
}

/**
 * The submit payload for the params form: field values from the FORM, the
 * `expectedVersion` from the SNAPSHOT — never from the background state.
 */
export function paramsPayload(snapshot, fields) {
  const payload = {
    priority: Number(fields.priority) || 0,
    dayNightPreference: fields.dayNightPreference || "any",
    notBefore: fields.notBefore || null,
    deadline: fields.deadline || null,
    unattendedAllowed: fields.unattendedAllowed === true
  };
  if (snapshot && typeof snapshot.version === "number") {
    payload.expectedVersion = snapshot.version;
  }
  return payload;
}
