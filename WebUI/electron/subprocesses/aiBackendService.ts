import { UvPythonBackendService } from './uvPythonBackendService.ts'

export type GpuHardwareDevice = {
  device: string
  name: string
  gpuDeviceId: string | null
}

export type HardwareDetectionResult = {
  success: boolean
  gpuDevices: GpuHardwareDevice[]
  error?: string
}

export class AiBackendService extends UvPythonBackendService {
  readonly serviceFolder = 'service'
  readonly isRequired = true

  protected override extraProcessEnv(): Record<string, string | undefined> {
    return {
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
    }
  }

  protected override extraInstallEnv(): Record<string, string> | undefined {
    return this.settings.productMode === 'nvidia' ? { UV_TORCH_BACKEND: 'cu128' } : undefined
  }
}
