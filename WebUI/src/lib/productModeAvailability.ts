import type { BackendServiceName } from '@/assets/js/store/backendServices'

/** Whether a Component can run in `mode` — the wizard and the live manager share this. */
export function isComponentAvailableInMode(
  mode: ProductMode | null,
  serviceName: BackendServiceName,
): boolean {
  if (mode === 'nvidia' && serviceName === 'openvino-backend') return false
  return true
}
