export const mqttTopics = {
  printerState: (printerId: string) => `print-orchestrator/printers/${printerId}/state`,
  jobState: (jobId: string) => `print-orchestrator/jobs/${jobId}/state`
};
