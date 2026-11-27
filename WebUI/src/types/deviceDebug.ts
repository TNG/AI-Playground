/**
 * Shapes for the temporary "Device list debug" probe (Settings → Developer).
 * Both the main-side probe and the renderer panel use these, so the two halves
 * cannot drift while the tool exists.
 */

export type DeviceDebugEntry = {
  id: string
  name: string
  uuid?: string | null
  selected?: boolean
}

export type DeviceDebugHardwareEntry = {
  /** Probe instance id (e.g. `INTEL_GPU:0`); may be enumeration-order based. */
  device: string
  name: string
  gpuDeviceId: string | null
  uuid?: string | null
  category: string
}

export type DeviceDebugBackendProbe = {
  devices: DeviceDebugEntry[]
  /** Where the list came from, e.g. `llama-server --list-devices`. */
  source: string
  /** False when the service could not be re-probed and its applied list is shown. */
  reProbed: boolean
  error?: string
}

export type DeviceDebugPreferredDevice = {
  name: string
  gpuDeviceId: string | null
  uuid?: string | null
  instanceId?: string
}

export type DeviceDebugSnapshot = {
  capturedAt: string
  platform: string
  hardware: DeviceDebugHardwareEntry[]
  backends: Record<string, DeviceDebugBackendProbe>
  persisted: {
    lastSelectedDevicePerBackend: Record<string, string>
    lastSelectedDeviceUuidPerBackend: Record<string, string>
    preferredDevice: DeviceDebugPreferredDevice | null
  }
}
