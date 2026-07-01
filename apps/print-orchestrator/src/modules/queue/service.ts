import { farmStore, type NewQueueJobInput } from "../../infra/store/farmStore";
import type { NightPrint, QueueJob } from "../../domain/dashboard/types";

export function listQueue(): QueueJob[] {
  return farmStore.getQueue();
}

export function getNightPrint(): NightPrint {
  return farmStore.getNight();
}

export function addQueueJob(input: NewQueueJobInput): QueueJob {
  return farmStore.addQueueJob(input);
}

export function startNext(): QueueJob {
  return farmStore.startNext();
}

export function startNight(): { candidate: NightPrint["candidates"][number]; window: string } {
  return farmStore.startNight();
}

export function pickNightCandidate(): NightPrint {
  return farmStore.advanceNightPick();
}
