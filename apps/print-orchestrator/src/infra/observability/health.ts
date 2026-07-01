import { env } from "../../shared/env";

export interface HealthResponse {
  status: "ok";
  service: string;
  uptimeSeconds: number;
}

export function getHealth(): HealthResponse {
  return {
    status: "ok",
    service: env.serviceName,
    uptimeSeconds: Math.round(process.uptime())
  };
}
