import { env } from "../../shared/env";

export interface ReadyResponse {
  status: "ready";
  service: string;
}

export async function getReadiness(): Promise<ReadyResponse> {
  return {
    status: "ready",
    service: env.serviceName
  };
}
