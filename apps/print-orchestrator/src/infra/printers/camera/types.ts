import type { Readable } from "node:stream";

export interface CameraFrame {
  data: Buffer;
  mime: string;
}

export interface CameraStream {
  body: Readable;
  mime: string;
  close: () => void;
}
