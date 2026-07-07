import { JobError, PrinterConnectionError, PrinterOfflineError } from "../../core/errors";
import type { PrinterView } from "../../domain/printers/types";
import type { PrinterConfig } from "../printers/config";
import {
  getPrinterLiveStatus,
  PrinterCommandError,
  sendPrinterCommand,
  sendPrinterStart,
  supportsPrinterLight,
  supportsPrinterStart,
  type PrinterCommand
} from "../printers/status";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";
import type { PrinterPoller, StoreLogger } from "./printerPoller";
import { buildPrinterView, isBusyStatus } from "./printerView";
import type { SnapshotMeta, SnapshotStore } from "./snapshotStore";

/** Result of a manual snapshot: the refreshed view plus the saved image's metadata. */
export interface SnapshotResult {
  printer: PrinterView;
  snapshot: SnapshotMeta;
}

/**
 * Operator actions dispatched to the real printer drivers. Each command checks
 * the live state first, dispatches, records the action in the feed, then
 * re-polls the printer so the returned view reflects reality.
 */
export class PrinterCommandService {
  private logger: StoreLogger = {};

  constructor(
    private readonly configById: (id: string) => PrinterConfig,
    private readonly poller: PrinterPoller,
    private readonly cameras: CameraService,
    private readonly events: EventFeed,
    private readonly snapshots: SnapshotStore
  ) {}

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  async pause(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.poller.getStatus(id);
    if (status?.status !== "printing") {
      throw new JobError(`Принтер «${printer.name}» не печатает — ставить на паузу нечего`);
    }
    await this.dispatch(printer, "pause");
    this.events.push("⏸", `Оператор поставил <b>${printer.name}</b> на паузу`, "info");
    return this.refresh(printer);
  }

  async resume(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.poller.getStatus(id);
    if (status?.status !== "paused") {
      throw new JobError(`Печать на «${printer.name}» не стоит на паузе`);
    }
    await this.dispatch(printer, "resume");
    this.events.push("▶", `<b>${printer.name}</b> продолжил печать`, "ok");
    return this.refresh(printer);
  }

  async cancel(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.poller.getStatus(id);
    if (!status || !isBusyStatus(status.status)) {
      throw new JobError(`На «${printer.name}» нет активной печати для отмены`);
    }
    const job = status.currentFile;
    await this.dispatch(printer, "cancel");
    this.events.push(
      "✕",
      `Печать «${job ?? "—"}» на <b>${printer.name}</b> отменена оператором`,
      "err"
    );
    return this.refresh(printer);
  }

  async setLight(id: string, on: boolean): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    if (!supportsPrinterLight(printer)) {
      throw new JobError(`Управление подсветкой для «${printer.name}» не настроено`);
    }

    // Route through the poller so the command is serialized with the schedule
    // (no manual/scheduled interleaving) and it installs the 5-minute override.
    try {
      await this.poller.applyManualLight(printer, on);
    } catch (error) {
      this.logger.warn?.(
        {
          err: error,
          printer: printer.id,
          on,
          reason: error instanceof Error ? error.message : String(error)
        },
        "manual light command failed"
      );
      if (error instanceof PrinterCommandError) {
        throw new JobError(error.message);
      }
      throw new PrinterConnectionError(
        printer.id,
        error instanceof Error ? error.message : String(error)
      );
    }

    this.logger.info?.({ printer: printer.id, on }, "manual light change");
    this.events.push(
      on ? "☾" : "☀",
      `<b>${printer.name}</b>: подсветка ${on ? "включена" : "выключена"} оператором; расписание вернётся через 5 минут`,
      "info"
    );
    return this.refresh(printer);
  }

  /**
   * Starts a print of a file already present on the printer. Refuses unless the
   * device is online and genuinely idle (never interrupts a running print), and
   * unless the protocol supports remote start. Re-polls so the returned view
   * reflects the device actually beginning the job.
   */
  async startPrint(id: string, file: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    if (!supportsPrinterStart(printer)) {
      throw new JobError(
        `Удалённый запуск печати для «${printer.name}» не поддерживается — запустите файл на самом принтере`
      );
    }

    const status = this.poller.getStatus(id);
    if (status && isBusyStatus(status.status)) {
      throw new JobError(`«${printer.name}» уже занят печатью — дождитесь завершения`);
    }
    if (status && status.status !== "idle" && status.status !== "unknown") {
      throw new JobError(`«${printer.name}» не готов к запуску (состояние: ${status.status})`);
    }

    await this.dispatchStart(printer, file);
    this.events.push("▶", `Оператор запустил печать «${file}» на <b>${printer.name}</b>`, "ok");
    return this.refresh(printer);
  }

  /**
   * Captures a fresh camera frame and saves it as a durable snapshot (file on
   * disk + metadata). The frame is grabbed anew (never the short-lived cache),
   * the file is written atomically, and only after it lands do we record the
   * event and return — so a capture failure produces an error, not a phantom
   * "snapshot saved" entry in the feed.
   */
  async snapshot(id: string): Promise<SnapshotResult> {
    const printer = this.configById(id);
    const frame = await this.cameras.captureFresh(printer);

    const status = this.poller.getStatus(id);
    const statusLabel = status
      ? status.currentFile
        ? `${status.status} · ${status.currentFile}`
        : status.status
      : null;

    const snapshot = await this.snapshots.save(printer.id, frame, { status: statusLabel });
    this.events.push("◉", `Снимок с камеры <b>${printer.name}</b> сохранён`, "info");

    const view = buildPrinterView(printer, status, this.cameras.getEntry(id), snapshot.url);
    return { printer: view, snapshot };
  }

  private getReachableConfig(id: string): PrinterConfig {
    const printer = this.configById(id);
    const status = this.poller.getStatus(id);
    if (!status || !status.online) {
      throw new PrinterOfflineError(id);
    }
    return printer;
  }

  private async dispatch(printer: PrinterConfig, command: PrinterCommand): Promise<void> {
    try {
      await sendPrinterCommand(printer, command);
    } catch (error) {
      if (error instanceof PrinterCommandError) {
        throw new JobError(error.message);
      }
      throw new PrinterConnectionError(
        printer.id,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async dispatchStart(printer: PrinterConfig, file: string): Promise<void> {
    try {
      await sendPrinterStart(printer, file);
    } catch (error) {
      if (error instanceof PrinterCommandError) {
        throw new JobError(error.message);
      }
      throw new PrinterConnectionError(
        printer.id,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** Re-polls one printer right after a command so the view reflects reality. */
  private async refresh(printer: PrinterConfig): Promise<PrinterView> {
    const status = await getPrinterLiveStatus(printer);
    this.poller.setStatus(printer.id, status);
    return buildPrinterView(printer, status, this.cameras.getEntry(printer.id));
  }
}
