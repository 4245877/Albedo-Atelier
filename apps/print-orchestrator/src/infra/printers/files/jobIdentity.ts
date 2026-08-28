import { anyAdapterStartableExtensions } from "../capabilities";
import { PRINTABLE_EXTENSIONS } from "./path";

/**
 * **Is the printer talking about *our* job?** — asked once, answered once.
 *
 * Three layers ask this question about the same physical print, and before this
 * module each answered it with its own private helper:
 *
 *  - `bambuStart.namesJob` stripped the container extension (`.gcode.3mf`) and
 *    then matched loosely, in both directions, with `includes`;
 *  - `runLifecycle.sameFile` compared **basenames verbatim**;
 *  - `startGuard.sameFile` did the same, independently.
 *
 * The three disagreed on exactly the case this farm runs every day. A Bambu
 * dispatch puts `cube-a1b2c3d4.gcode.3mf` on the card and the device reports the
 * running job as `subtask_name: "cube-a1b2c3d4"` — the name *without* the
 * container extension, because that is the field's semantics. So the start was
 * confirmed (`namesJob` stripped it) and then the very next status poll declared
 * the identity **lost** (`sameFile` did not), moving a perfectly healthy run to
 * `UNKNOWN`: the task stayed `PRINTING` forever, the bed stayed `RUNNING`, no
 * clearance operation was ever opened, and the printer went on refusing its own
 * queue as busy.
 *
 * The rule below is therefore the single source of truth, and every comparison
 * of "the file we dispatched" against "the file the device names" goes through
 * it. It is deliberately **exact on the normalized key** rather than fuzzy:
 * `includes` in either direction is a false-*confirmation* generator (a stale
 * `cube` running on the plate would confirm the start of `cube-a1b2c3d4`, and a
 * `cube-a1b2c3d4_repaired` would confirm `cube`), and a false confirmation is
 * how one model gets printed twice.
 *
 * Normalization, and nothing beyond it:
 *
 *  - the last path segment only (`/` or `\`), because a device may report a
 *    path (`/data/cube.gcode`) where we hold a bare name;
 *  - one longest-match strip of a *known* printable/container extension — the
 *    union over every implemented adapter, so `.gcode.3mf` is removed whole and
 *    never split at `.3mf`;
 *  - trim and case-fold, because FAT/exFAT names are case-insensitive and
 *    firmwares differ on the case they echo.
 *
 * A name that carries an extension nobody can start is left intact: dropping an
 * unknown suffix would merge two genuinely different files.
 */

/**
 * Every extension a job name may legitimately carry, longest-match first.
 *
 * Derived from the capability table rather than restated, so an adapter added
 * with a new container extension is understood here without a second edit —
 * the duplication that produced the bug this module exists to fix.
 */
function knownJobExtensions(): readonly string[] {
  const seen = new Set<string>([...anyAdapterStartableExtensions(), ...PRINTABLE_EXTENSIONS]);
  // `.3mf` on its own is not startable everywhere but is a container name the
  // device may echo, so it is understood even where it could not be started.
  seen.add(".3mf");
  return [...seen].sort((a, b) => b.length - a.length);
}

const JOB_EXTENSIONS = knownJobExtensions();

/**
 * The comparable identity of a job/file name, or `""` when there is none.
 *
 * `""` never matches anything — an absent name is not evidence of agreement,
 * which is the fail-closed half of {@link sameJobFile}.
 */
export function jobIdentityKey(value: string | null | undefined): string {
  return jobNameStem(value).toLowerCase();
}

/**
 * The job's bare name — path and container extension removed, **case
 * preserved**.
 *
 * This is what gets *announced* to a device (a Bambu `subtask_name`, which the
 * printer shows on its screen), while {@link jobIdentityKey} is what gets
 * *compared*. Same stripping rule, so the announced name and the name the
 * confirmation looks for cannot drift apart; different case handling, so the
 * operator is not shown a name we quietly lower-cased.
 */
export function jobNameStem(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const base = (value.split(/[\\/]/).pop() ?? value).trim();
  if (!base) return "";
  const lower = base.toLowerCase();
  for (const ext of JOB_EXTENSIONS) {
    if (lower.endsWith(ext) && lower.length > ext.length) {
      return base.slice(0, base.length - ext.length).trim();
    }
  }
  return base;
}

/**
 * Whether two names denote the same print job.
 *
 * False whenever either side is missing: "the device is not saying" and "the
 * device names a different file" are different facts, and only the caller knows
 * which of the two it may act on.
 */
export function sameJobFile(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = jobIdentityKey(a);
  if (!keyA) return false;
  return keyA === jobIdentityKey(b);
}

/**
 * Whether any of the fields a device reports names the job `wanted`.
 *
 * Devices spread the answer over several fields depending on firmware and job
 * type (a Bambu project print names it in `subtask_name` while `gcode_file`
 * points at `Metadata/plate_1.gcode` *inside* the container), so agreement in
 * any one field is agreement.
 */
export function anyNamesJob(reported: readonly unknown[], wanted: string): boolean {
  const key = jobIdentityKey(wanted);
  if (!key) return false;
  return reported.some((value) => typeof value === "string" && jobIdentityKey(value) === key);
}
