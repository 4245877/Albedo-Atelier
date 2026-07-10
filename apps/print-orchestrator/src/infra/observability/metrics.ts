import { farmStore } from "../../app/farmStore";

interface Metric {
  name: string;
  help: string;
  type: "gauge" | "counter";
  value: number | null;
}

const PREFIX = "print_orchestrator_";

/**
 * Real farm counters in Prometheus text exposition format, drawn from the live
 * poll state (see {@link FarmStore.getMetricsSnapshot}). Metrics whose value is
 * not yet known (e.g. the poll has not run) are omitted rather than reported as
 * a misleading zero.
 */
export function collectMetrics(): string {
  const m = farmStore.reads.getMetricsSnapshot();

  const metrics: Metric[] = [
    { name: "up", help: "1 when the service is running", type: "gauge", value: m.up },
    { name: "uptime_seconds", help: "Seconds since the service started", type: "gauge", value: m.uptimeSeconds },
    { name: "last_poll_age_seconds", help: "Seconds since the last successful printer poll", type: "gauge", value: m.lastPollAgeSeconds },
    { name: "degraded", help: "1 when any printer is offline/errored or the config is broken", type: "gauge", value: m.degraded },
    { name: "printers_total", help: "Enabled printers in the config", type: "gauge", value: m.printersTotal },
    { name: "printers_online", help: "Printers currently reachable", type: "gauge", value: m.printersOnline },
    { name: "printers_printing", help: "Printers currently printing", type: "gauge", value: m.printersPrinting },
    { name: "printers_error", help: "Printers reporting an error", type: "gauge", value: m.printersError },
    { name: "cameras_total", help: "Printers with a configured camera", type: "gauge", value: m.camerasTotal },
    { name: "cameras_online", help: "Cameras currently reachable", type: "gauge", value: m.camerasOnline },
    { name: "queue_jobs", help: "Jobs in the in-memory queue", type: "gauge", value: m.queueJobs },
    { name: "prints_completed_today", help: "Completions observed since the counter last rolled over", type: "counter", value: m.completedToday },
    { name: "prints_failed_today", help: "Failures observed since the counter last rolled over", type: "counter", value: m.failedToday }
  ];

  const lines: string[] = [];
  for (const metric of metrics) {
    if (metric.value === null) continue;
    const fqName = `${PREFIX}${metric.name}`;
    lines.push(`# HELP ${fqName} ${metric.help}`);
    lines.push(`# TYPE ${fqName} ${metric.type}`);
    lines.push(`${fqName} ${metric.value}`);
  }
  return `${lines.join("\n")}\n`;
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
