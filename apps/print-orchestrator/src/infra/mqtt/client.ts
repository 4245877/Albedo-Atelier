export interface MqttClient {
  publish(topic: string, payload: unknown): Promise<void>;
}

export function createNoopMqttClient(): MqttClient {
  return {
    async publish(_topic: string, _payload: unknown): Promise<void> {
      return undefined;
    }
  };
}
