import { NotFoundError, ValidationError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  isEnvPlaceholder,
  PRINTER_SECRET_FIELDS,
  type PrinterRecord,
  type PrinterSecretField
} from "../../domain/printers/config";
import {
  buildPrinterInventory,
  type PrinterInventorySnapshot
} from "../../domain/printers/inventory";
import { buildPrinterRecord, type PrinterInput } from "../../domain/printers/validation";
import type { PrinterConfig } from "../../infra/printers/config";
import { materializePrinter } from "../../infra/printers/materialize";
import {
  disconnectPrinter,
  getPrinterLiveStatus
} from "../../infra/printers/status";
import type { StoreLogger } from "../../shared/logger";
import { recordAuditEvent, type AuditInput } from "../audit";

/**
 * How a credential is configured, without ever disclosing it. `env` names the
 * variable the value is read from — that is a *reference*, not the secret, and
 * showing it is what lets the UI say «берётся из ${BAMBU_A1_ACCESS_CODE}»
 * instead of an unexplained blank field.
 */
export interface SecretStatus {
  set: boolean;
  source: "literal" | "env" | "none";
  /** The `${VAR}` reference when `source === "env"`, else null. */
  envVar: string | null;
  /** For an env reference: whether that variable actually resolves to a value. */
  resolved: boolean;
}

/** One printer's settings as the API returns them — credentials replaced by status. */
export interface PrinterConfigView
  extends Omit<PrinterRecord, "apiKey" | "serial" | "accessCode"> {
  secrets: Record<PrinterSecretField, SecretStatus>;
}

export interface PrinterConnectionTest {
  printerId: string;
  online: boolean;
  status: string;
  /** Device-reported reason when it is not reachable; null when it is. */
  error: string | null;
  checkedAt: string;
}

export interface PrinterConfigServiceOptions {
  now?: () => Date;
  actor?: string;
  logger?: StoreLogger;
  /**
   * Called after every committed change with the id that changed (null for a
   * bulk reorder). The runtime uses it to install the new config into the live
   * poller; dropping stale device connections is this service's own job.
   */
  onChanged?: (changedPrinterId: string | null) => void;
  /** Injected in tests so a connection probe never touches a real device. */
  probe?: (printer: PrinterConfig) => Promise<{ online: boolean; status: string; error: string | null }>;
  /** Drops a printer's live device connection; the real adapter by default. */
  disconnect?: (printerId: string) => void;
}

/** How long a Bambu probe waits for the first MQTT report before giving up. */
const BAMBU_PROBE_TIMEOUT_MS = 8000;
const BAMBU_PROBE_INTERVAL_MS = 400;

/**
 * The printer configuration service: the farm's own hardware inventory, owned by
 * the database and editable at runtime.
 *
 * It exists so that the operations this replaces — «сбросили код доступа на
 * принтере → поправить файл в репозитории → пересобрать → передеплоить» — become
 * one PATCH. Three rules it holds to:
 *
 *  - **credentials go in, never out.** {@link view} returns a {@link SecretStatus}
 *    (set / not set / read from which env var), never the value. An update that
 *    omits a credential keeps the stored one, which is what lets the UI submit
 *    the whole form without ever having held the secret;
 *  - **a change takes effect immediately.** Every committed write re-materializes
 *    the config and notifies the runtime, and a credential change additionally
 *    drops the live device connection — a cached Bambu MQTT client authenticated
 *    with the *old* access code would otherwise keep reporting the printer as
 *    fine until the next restart, which is the exact failure this feature is
 *    meant to remove;
 *  - **input is validated strictly** (`domain/printers/validation.ts`): the
 *    operator gets a 400 naming the field instead of a silently dropped value.
 */
export class PrinterConfigService {
  private readonly nowFn: () => Date;
  private readonly actor: string;
  private readonly logger: StoreLogger;
  private readonly onChanged?: (changedPrinterId: string | null) => void;
  private readonly probeFn?: PrinterConfigServiceOptions["probe"];
  private readonly disconnect: (printerId: string) => void;

  constructor(
    private readonly store: PrintQueueStore,
    options: PrinterConfigServiceOptions = {}
  ) {
    this.nowFn = options.now ?? (() => new Date());
    this.actor = options.actor ?? "operator";
    this.logger = options.logger ?? {};
    this.onChanged = options.onChanged;
    this.probeFn = options.probe;
    this.disconnect = options.disconnect ?? disconnectPrinter;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Every configured printer in operator order, credentials masked. */
  list(): PrinterConfigView[] {
    return this.store.repositories.printers.list().map((record) => toView(record));
  }

  get(id: string): PrinterConfigView {
    return toView(this.require(id));
  }

  /**
   * The inter-service inventory snapshot (`GET /api/printers/inventory`):
   * configuration only, disabled printers included and flagged, no connection
   * parameters and no credentials. Kept here rather than in the route so the
   * projection has exactly one implementation — see `domain/printers/inventory`.
   */
  inventory(): PrinterInventorySnapshot {
    return buildPrinterInventory(this.store.repositories.printers.list());
  }

  /** The runtime configs the poller/drivers consume (`${ENV}` expanded). */
  materialize(): PrinterConfig[] {
    return this.store.repositories.printers.list().map(materializePrinter);
  }

  /** How many printers are configured — used by the boot log and the read model. */
  count(): number {
    return this.store.repositories.printers.list().length;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  create(input: PrinterInput, actor?: string): PrinterConfigView {
    const record = this.store.transaction(() => {
      const repos = this.store.repositories;
      const built = buildPrinterRecord(input, {
        now: this.nowIso(),
        nextPosition: repos.printers.maxPosition() + 10
      });
      if (repos.printers.getById(built.id)) {
        throw new ValidationError(
          `Принтер с id «${built.id}» уже настроен — выберите другой идентификатор`,
          { field: "id" }
        );
      }
      repos.printers.insert(built);
      this.audit({
        entityType: "printer",
        entityId: built.id,
        action: "created",
        actor,
        detail: describe(built)
      });
      return built;
    });

    this.notify(record.id);
    this.logger.info?.(
      { printer: record.id, protocol: record.protocol, enabled: record.enabled },
      "printer added from the dashboard"
    );
    return toView(record);
  }

  /**
   * Applies a partial update. Absent keys keep their stored value — including
   * the credentials, so the edit form never has to round-trip a secret.
   */
  update(id: string, input: PrinterInput, actor?: string): PrinterConfigView {
    const { record, secretsChanged, disabled } = this.store.transaction(() => {
      const existing = this.require(id);
      // The id is the key of snapshot directories, API paths and every
      // `printer_id` in the queue: renaming it is a data migration, not an edit.
      if (typeof input.id === "string" && input.id.trim() && input.id.trim() !== id) {
        throw new ValidationError(
          "Идентификатор принтера изменить нельзя — он используется в путях снимков и ссылках. Создайте новый принтер",
          { field: "id" }
        );
      }
      const next = buildPrinterRecord(input, { base: existing, now: this.nowIso() });
      const changedSecrets = PRINTER_SECRET_FIELDS.filter((f) => next[f] !== existing[f]);
      const written = this.store.repositories.printers.update(next);
      this.audit({
        entityType: "printer",
        entityId: id,
        action: "updated",
        actor,
        // Names of the credential fields that changed — never their values.
        detail: { ...describe(written), secretsChanged: changedSecrets }
      });
      return {
        record: written,
        secretsChanged: changedSecrets,
        disabled: existing.enabled && !written.enabled
      };
    });

    // Credentials changed → the connection opened with the old ones is worthless
    // and, worse, still reports a plausible status. Drop it so the next poll
    // reconnects with what the operator just entered.
    //
    // A printer that was just *disabled* is dropped for a different reason: the
    // poll loop stops visiting it, so nothing would ever close its client or its
    // keep-alive timer — a disabled Bambu would hold an MQTT session open until
    // the service restarts.
    if (secretsChanged.length > 0 || disabled || this.connectionAffecting(input)) {
      this.disconnect(id);
    }
    this.notify(id);
    this.logger.info?.(
      { printer: id, secretsChanged: secretsChanged.length > 0 },
      "printer settings updated from the dashboard"
    );
    return toView(record);
  }

  /**
   * Enable/disable without touching anything else — the switch an operator
   * reaches for when a printer is physically unplugged for a while.
   */
  setEnabled(id: string, enabled: boolean, actor?: string): PrinterConfigView {
    return this.update(id, { enabled }, actor);
  }

  /**
   * Removes a printer from the farm. Its history (runs, assignments, snapshots)
   * references the id by value and is deliberately left intact — deleting a
   * printer must not erase what it printed.
   */
  remove(id: string, actor?: string): void {
    this.store.transaction(() => {
      const existing = this.require(id);
      this.store.repositories.printers.delete(id);
      this.audit({
        entityType: "printer",
        entityId: id,
        action: "deleted",
        actor,
        detail: { name: existing.name, protocol: existing.protocol }
      });
    });
    this.disconnect(id);
    this.notify(id);
    this.logger.warn?.({ printer: id }, "printer removed from the farm config");
  }

  /** Moves printers into the given order; unnamed printers keep their relative order. */
  reorder(ids: string[], actor?: string): PrinterConfigView[] {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const now = this.nowIso();
      let position = 0;
      for (const id of ids) {
        const existing = repos.printers.getById(id);
        if (!existing) throw new NotFoundError(`Принтер «${id}»`);
        position += 10;
        repos.printers.update({ ...existing, position, updatedAt: now });
      }
      // Anything the client did not name keeps a stable slot after the named set.
      for (const rest of repos.printers.list()) {
        if (ids.includes(rest.id)) continue;
        position += 10;
        repos.printers.update({ ...rest, position, updatedAt: now });
      }
      this.audit({ entityType: "printer", entityId: "*", action: "reordered", actor, detail: { ids } });
    });
    this.notify(null);
    return this.list();
  }

  // ── Connection probe ───────────────────────────────────────────────────────

  /**
   * Asks the real device whether the current settings work, and answers with what
   * it said. This is the check that closes the loop after a credential reset: an
   * operator can see «код доступа принят» before trusting the farm with a print.
   *
   * The printer's connection is dropped first, so the probe can never be answered
   * by a client authenticated with the previous credentials. Bambu is polled until
   * its first MQTT report arrives (the protocol has no synchronous handshake);
   * Moonraker and Creality answer in one request.
   */
  async testConnection(id: string, actor?: string): Promise<PrinterConnectionTest> {
    const record = this.require(id);
    const config = materializePrinter(record);

    this.disconnect(id);
    const probed = await this.probeDevice(config);
    // The operator asked a question; answer it in their language. The driver's
    // raw text is folded in, never replaced (see humanizeProbeError).
    const result = {
      ...probed,
      error: probed.online ? null : humanizeProbeError(probed.error, config)
    };

    const checkedAt = this.nowIso();
    this.store.transaction(() => {
      this.audit({
        entityType: "printer",
        entityId: id,
        action: "connection_tested",
        actor,
        detail: { online: result.online, status: result.status, error: result.error }
      });
    });
    return { printerId: id, ...result, checkedAt };
  }

  private async probeDevice(
    config: PrinterConfig
  ): Promise<{ online: boolean; status: string; error: string | null }> {
    if (this.probeFn) return this.probeFn(config);

    const read = async (): Promise<{ online: boolean; status: string; error: string | null }> => {
      const status = await getPrinterLiveStatus(config);
      return { online: status.online, status: status.status, error: status.error ?? null };
    };

    let last = await read();
    if (last.online || config.protocol !== "bambu") return last;

    // Bambu LAN is push-based: the first read only opens the MQTT client, so a
    // single "offline" answer means "no report yet", not "bad credentials".
    // Wait for the real answer — an auth failure surfaces here as an error too.
    const deadline = Date.now() + BAMBU_PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(BAMBU_PROBE_INTERVAL_MS);
      last = await read();
      if (last.online) break;
    }
    return last;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private require(id: string): PrinterRecord {
    const record = this.store.repositories.printers.getById(id);
    if (!record) throw new NotFoundError(`Принтер «${id}»`);
    return record;
  }

  /**
   * Whether the patch touches something a live connection was built from. Host,
   * port, protocol and the TLS opt-in all change *where and how* we connect, so
   * the cached client must go even though no credential moved.
   */
  private connectionAffecting(input: PrinterInput): boolean {
    return ["host", "port", "protocol", "allowInsecureTls"].some((key) =>
      Object.prototype.hasOwnProperty.call(input, key)
    );
  }

  private notify(changedPrinterId: string | null): void {
    this.onChanged?.(changedPrinterId);
  }

  private audit(input: AuditInput): void {
    recordAuditEvent(this.store, () => this.nowIso(), this.actor, input);
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }
}

/** Strips the credentials and replaces them with their configuration status. */
export function toView(record: PrinterRecord): PrinterConfigView {
  const { apiKey, serial, accessCode, ...rest } = record;
  return {
    ...rest,
    secrets: {
      apiKey: secretStatus(apiKey),
      serial: secretStatus(serial),
      accessCode: secretStatus(accessCode)
    }
  };
}

function secretStatus(value: string): SecretStatus {
  const trimmed = value.trim();
  if (!trimmed) return { set: false, source: "none", envVar: null, resolved: false };
  if (isEnvPlaceholder(trimmed)) {
    const envVar = trimmed.slice(2, -1);
    return {
      set: true,
      source: "env",
      envVar,
      // An unset variable expands to "" — the printer is effectively unconfigured,
      // and saying so here is what turns a silent "offline" into a fixable fact.
      resolved: Boolean(process.env[envVar])
    };
  }
  return { set: true, source: "literal", envVar: null, resolved: true };
}

/**
 * Turns a driver's raw failure into something an operator can act on.
 *
 * The device adapters pass the underlying network error through verbatim, which
 * for the commonest case — nothing answers at that address — is an untranslated
 * `"The operation was aborted due to timeout"`. That is fine as telemetry
 * (`PrinterView.error` is diagnostic), but this is the answer to a button the
 * operator pressed to ask "did I wire this up right?", so it names the likely
 * cause instead. The original text is kept after the dash — it is what
 * distinguishes a refused connection from a silent one.
 */
function humanizeProbeError(error: string | null, config: PrinterConfig): string | null {
  const address = config.port ? `${config.host}:${config.port}` : config.host;
  if (!error) return `Принтер не ответил по адресу ${address}`;

  if (/timeout|aborted|ETIMEDOUT/i.test(error)) {
    return `Принтер не ответил по адресу ${address} за отведённое время — проверьте адрес, порт и что устройство включено и в той же сети (${error})`;
  }
  if (/ECONNREFUSED|refused/i.test(error)) {
    return `Соединение с ${address} отклонено — по этому адресу никто не слушает указанный порт (${error})`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error)) {
    return `Не удалось разрешить имя «${config.host}» — укажите IP-адрес или проверьте DNS (${error})`;
  }
  if (/EHOSTUNREACH|ENETUNREACH|unreachable/i.test(error)) {
    return `Адрес ${address} недостижим из сети сервиса (${error})`;
  }
  return error;
}

/** Audit detail for a printer write — identity and wiring only, never secrets. */
function describe(record: PrinterRecord): Record<string, unknown> {
  return {
    name: record.name,
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    enabled: record.enabled
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
