import { randomUUID } from "node:crypto";

/**
 * Entity id prefixes. A prefixed id (`task_…`, `run_…`) is self-describing in
 * logs, audit rows and foreign keys, so a stray id is easy to trace to its
 * table without a lookup.
 */
export const ID_PREFIX = {
  artifact: "art",
  artifactAnalysis: "ana",
  printTask: "task",
  queueEntry: "qe",
  plan: "plan",
  assignment: "asg",
  bedCycle: "bed",
  dispatchAttempt: "dsp",
  printRun: "run",
  materialOverride: "mat",
  auditEvent: "aud",
  // slicing domain (domain/slicing)
  profileRevision: "prof",
  profileSet: "pset",
  sliceVariant: "slc"
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** A fresh, globally-unique id: `<prefix>_<uuid>` (e.g. `task_9f2c…`). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}
