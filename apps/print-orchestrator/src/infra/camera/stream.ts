export interface CameraStream {
  printerId: string;
  url: string;
}

export async function getStream(_printerId: string): Promise<CameraStream | undefined> {
  return undefined;
}
