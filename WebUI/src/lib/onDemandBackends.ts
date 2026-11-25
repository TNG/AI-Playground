/** Sidecars that stay stopped once installed until first use: TTS/STT and Hermes Agent. */
export const ON_DEMAND_BACKENDS = [
  'qwen3-tts-backend',
  'whisper-backend',
  'hermes-backend',
] as const satisfies readonly BackendServiceName[]

export function isOnDemandBackend(name: string): boolean {
  return (ON_DEMAND_BACKENDS as readonly string[]).includes(name)
}
