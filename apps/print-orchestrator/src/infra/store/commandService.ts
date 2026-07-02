import { JobError, PrinterConnectionError, PrinterOfflineError } from "../../core/errors";
import { env } from "../../shared/env";
import { isWithinLocalTimeWindow } from "../../shared/time";
import type { PrinterView } from "../../domain/printers/types";
import type { PrinterConfig } from "../printers/config";
import {
  getPrinterLiveStatus,
  PrinterCommandError,
  sendPrinterCommand,
  sendPrinterLight,
  supportsPrinterLight,
  type PrinterCommand
} from "../printers/status";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";
import type { PrinterPoller } from "./printerPoller";
import { buildPrinterView, isBusyStatus } from "./printerView";

/**
 * Operator actions dispatched to the real printer drivers. Each command checks
 * the live state first, dispatches, records the action in the feed, then
 * re-polls the printer so the returned view reflects reality.
 */
export class PrinterCommandService {
  constructor(
    private readonly configById: (id: string) => PrinterConfig,
    private readonly poller: PrinterPoller,
    private readonly cameras: CameraService,
    private readonly events: EventFeed
  ) {}

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
    if (on && !isWithinLocalTimeWindow(env.nightWindow)) {
      throw new JobError(
        `Подсветку «${printer.name}» можно включать только ночью (${env.nightWindow}); днём она выключается автоматически`
      );
    }

    await this.dispatchLight(printer, on);
    this.events.push(
      on ? "☾" : "☀",
      `<b>${printer.name}</b>: подсветка ${on ? "включена" : "выключена"} оператором`,
      "info"
    );
    return this.refresh(printer);
  }

  async snapshot(id: string): Promise<PrinterView> {
    const printer = this.configById(id);
    await this.cameras.getFrame(printer);
    this.events.push("◉", `Сделан снимок с камеры <b>${printer.name}</b>`, "info");
    return buildPrinterView(printer, this.poller.getStatus(id), this.cameras.getEntry(id));
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

  private async dispatchLight(printer: PrinterConfig, on: boolean): Promise<void> {
    try {
      await sendPrinterLight(printer, on);
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
