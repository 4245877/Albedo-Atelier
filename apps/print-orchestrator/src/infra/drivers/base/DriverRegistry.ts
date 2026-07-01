import type { DriverConnectionConfig, PrinterDriver } from "./PrinterDriver";

export type PrinterDriverFactory = (config: DriverConnectionConfig) => PrinterDriver;

export class DriverRegistry {
  private readonly factories = new Map<string, PrinterDriverFactory>();

  register(name: string, factory: PrinterDriverFactory): void {
    this.factories.set(name, factory);
  }

  get(name: string): PrinterDriverFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}

export const driverRegistry = new DriverRegistry();
