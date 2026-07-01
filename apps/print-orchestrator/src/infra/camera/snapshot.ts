export interface CameraSnapshot {
  printerId: string;
  contentType: string;
  data: Buffer;
}

export async function getSnapshot(_printerId: string): Promise<CameraSnapshot | undefined> {
  return undefined;
}
