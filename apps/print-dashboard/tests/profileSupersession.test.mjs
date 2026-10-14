import assert from "node:assert/strict";
import { test } from "node:test";

import { createSetHtml, setsHtml } from "../features/slicing/view.js";

/*
 * HIGH-10 on the slicing page. A profile revision whose bytes the catalog now
 * resolves differently is SUPERSEDED: it keeps serving the sets already
 * approved on it, but it is not offered for a new set, a set built on it cannot
 * be (re-)approved, and the way to adopt the new settings is one button —
 * «Создать обновлённый набор» — which the server answers with a new,
 * unapproved set on the current revisions.
 */

const COVERAGE = [{ printerId: "creality-k2", printerName: "K2", printerClass: null, hasActiveProfile: true }];

function profile(id, type, name, extra = {}) {
  return { id, type, name, status: "active", logicalId: `${type}:${name}`, warnings: [], blockers: [], metadata: {}, ...extra };
}

const STATE = {
  runtime: { coverage: COVERAGE },
  profiles: [
    profile("old-machine", "machine", "K2 PETG 0.4", { metadata: { supersededBy: "new-machine" } }),
    profile("new-machine", "machine", "K2 PETG 0.4"),
    profile("proc", "process", "K2 Standard 0.2"),
    profile("fil", "filament", "PETG @K2")
  ]
};

test("a superseded revision is not offered for a new set; the current one is", () => {
  const html = createSetHtml(STATE);
  assert.match(html, /value="new-machine"/);
  assert.doesNotMatch(html, /value="old-machine"/);
});

const SUPERSEDED_WARNING = {
  code: "profile_superseded",
  message: "Профиль «K2 PETG 0.4» каталог теперь разрешает иначе (ревизия new-machine)"
};

test("an approved set on a superseded revision stays approved and offers the successor", () => {
  const html = setsHtml({
    sets: [{ id: "pset_1", name: "K2 · PETG", validation: "warnings", approved: true, printerId: "creality-k2", warnings: [SUPERSEDED_WARNING], blockers: [] }]
  });
  assert.match(html, /утверждён/);
  assert.match(html, /data-slice-action="successor" data-id="pset_1"/);
  assert.match(html, /каталог теперь разрешает иначе/);
});

test("an unapproved set on a superseded revision cannot be approved — only succeeded", () => {
  const html = setsHtml({
    sets: [{ id: "pset_2", name: "K2 · черновик", validation: "warnings", approved: false, printerId: "creality-k2", warnings: [SUPERSEDED_WARNING], blockers: [] }]
  });
  assert.match(html, /data-slice-action="approve" data-id="pset_2" disabled/);
  assert.match(html, /data-slice-action="successor" data-id="pset_2"/);
});

test("a set on current revisions shows neither the successor button nor a disabled approve", () => {
  const html = setsHtml({
    sets: [{ id: "pset_3", name: "K2 · свежий", validation: "valid", approved: false, printerId: "creality-k2", warnings: [], blockers: [] }]
  });
  assert.doesNotMatch(html, /successor/);
  assert.match(html, /data-slice-action="approve" data-id="pset_3">/);
});
