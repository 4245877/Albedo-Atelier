export interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

export function collectMetrics(): MetricSample[] {
  return [];
}
