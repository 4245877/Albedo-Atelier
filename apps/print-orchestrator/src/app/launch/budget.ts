import {
  COMMAND_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS
} from "../../infra/printers/files/bambuFtps";
import { MOONRAKER_UPLOAD_TIMEOUT_MS } from "../../infra/printers/files/upload";
import { START_CONFIRM_TIMEOUT_MS } from "../../infra/printers/status/bambuStart";

/**
 * **How long a launch can legitimately take**, derived from the steps it is made
 * of rather than guessed at.
 *
 * `POST /api/print/launch` does the whole physical chain in one request: build
 * the device package, push it to the printer, verify it landed, send the start,
 * and wait for the device to confirm. Each step has its own timeout, in its own
 * module, and the *client's* deadline was a separate hand-tuned constant in a
 * separate repository. The two drifted into an overlap: 240 s on the dashboard
 * against a server path that can serially spend 180 s transferring, ~25 s
 * re-listing to verify, and 45 s waiting for confirmation — before the package
 * build and the MQTT round-trips.
 *
 * That overlap has one specific consequence, and it is not a slow UI. When the
 * client gives up first, the operator is told the launch failed **while the
 * printer is still starting it**. The only party that knows the truth is the one
 * that was cut off, and the natural next action — press it again — is the one
 * action that risks a second print. (It does not actually print twice: the
 * launch carries an idempotency key and the durable start guard refuses a second
 * dispatch. But the operator is left choosing between two stories about their
 * own machine, which is the failure this budget removes.)
 *
 * So the worst case is computed here, once, from the constants that actually
 * bound each step, and the client deadline is required to exceed it. Raising any
 * step's timeout raises this number automatically, and the invariant test fails
 * if the client is no longer given enough room.
 */

/** The slowest implemented delivery: FTPS connect + a few commands + the transfer. */
const BAMBU_DELIVERY_MS = CONNECT_TIMEOUT_MS + COMMAND_TIMEOUT_MS * 3 + TRANSFER_TIMEOUT_MS;

/**
 * Verifying the delivery re-lists the directory, which for Bambu is a second
 * FTPS session of its own.
 */
const VERIFY_MS = CONNECT_TIMEOUT_MS + COMMAND_TIMEOUT_MS * 2;

/** Building the device package and the MQTT round-trips around the start. */
const OVERHEAD_MS = 20_000;

/**
 * The longest a single launch request can take before every server-side step has
 * given up — the number a client deadline must exceed.
 */
export const LAUNCH_WORST_CASE_MS =
  Math.max(BAMBU_DELIVERY_MS, MOONRAKER_UPLOAD_TIMEOUT_MS) +
  VERIFY_MS +
  START_CONFIRM_TIMEOUT_MS +
  OVERHEAD_MS;

/**
 * Margin between the server's worst case and the client's deadline.
 *
 * The client must be the LAST to give up: if it is not, a launch that the server
 * would have reported honestly becomes a phantom failure. Thirty seconds covers
 * request queueing, a reverse proxy's own buffering, and a busy event loop.
 */
export const LAUNCH_CLIENT_MARGIN_MS = 30_000;

/** The deadline a client must use for `POST /api/print/launch`. */
export const LAUNCH_CLIENT_DEADLINE_MS = LAUNCH_WORST_CASE_MS + LAUNCH_CLIENT_MARGIN_MS;
