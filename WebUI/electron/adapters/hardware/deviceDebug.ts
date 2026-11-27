import type { LocalSettings } from '../../kernel/localSettings'
import type { DeviceDebugSnapshot } from '@/types/deviceDebug'
import type { ApiService } from '../backends/service'
import { classifyDetectedDevices, detectGpuHardwareDevices } from './hardwareDiscovery'

/**
 * One read-only capture for the device-list debug panel: the fresh OS/GPU probe
 * plus every backend's own enumeration. Nothing here selects or persists, so the
 * snapshot shows the lists as the OS currently reports them.
 */
export async function captureDeviceDebugSnapshot(
  services: ApiService[],
  settings: LocalSettings,
): Promise<DeviceDebugSnapshot> {
  let hardware: DeviceDebugSnapshot['hardware'] = []
  try {
    const probe = await detectGpuHardwareDevices()
    hardware = classifyDetectedDevices(probe.detected)
  } catch {
    hardware = []
  }

  const backends: DeviceDebugSnapshot['backends'] = {}
  await Promise.all(
    services.map(async (service) => {
      try {
        if (service.probeDevices) {
          const probe = await service.probeDevices()
          backends[service.name] = {
            devices: probe.devices,
            source: probe.source,
            reProbed: true,
            ...(probe.error ? { error: probe.error } : {}),
          }
          return
        }
        backends[service.name] = {
          devices: service.get_info().devices,
          source: 'applied device list (not re-probed)',
          reProbed: false,
        }
      } catch (e) {
        backends[service.name] = {
          devices: service.get_info().devices,
          source: 'probe failed; applied list shown',
          reProbed: false,
          error: String(e),
        }
      }
    }),
  )

  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    hardware,
    backends,
    persisted: {
      lastSelectedDevicePerBackend: { ...settings.lastSelectedDevicePerBackend },
      lastSelectedDeviceUuidPerBackend: { ...settings.lastSelectedDeviceUuidPerBackend },
      preferredDevice: settings.preferredDevice,
    },
  }
}
