/**
 * Normalized view of one entry on the printer's storage (virtual SD card).
 * Paths are always relative to the printer's G-code root (`gcodes` for
 * Moonraker) and use `/` separators — the same form the remote-start command
 * (`startPrint`) expects, so a `path` from here can be started as-is.
 */
export interface PrinterFileEntry {
  /** Base name of the file or directory. */
  name: string;
  /** Full path relative to the G-code root, e.g. "folder/model.gcode". */
  path: string;
  type: "file" | "directory";
  /** Size in bytes; absent when the device does not report it. */
  size?: number;
  /** Last-modified time (ISO 8601); absent when the device does not report it. */
  modifiedAt?: string;
  /** Whether this entry can be started as a print (a file with a G-code extension). */
  printable: boolean;
  /** Slicer metadata reported by the device (estimated time, filament…); shape varies. */
  metadata?: unknown;
}

/** One listed directory: the normalized path that was listed plus its entries. */
export interface PrinterFilesListing {
  /** Normalized relative path that was listed; "" is the G-code root. */
  path: string;
  entries: PrinterFileEntry[];
}
