import type { RequiredModel } from '@/lib/presetSchemas'
import type { IpcOkWith } from '@/types/ipcChannels'
import { resolveSdCppImageModels, type SdCppImageModels } from '../adapters/backends/sdcppPhison.ts'

type SdCppImageService = {
  startImageServer(models: SdCppImageModels, onProgress?: () => void): Promise<string>
}

function isSdCppImageService(service: unknown): service is SdCppImageService {
  return (
    typeof service === 'object' &&
    service !== null &&
    'startImageServer' in service &&
    typeof service.startImageServer === 'function'
  )
}

/** Starts sd-server with the preset's three weights, resolved to their download folders. */
export async function ensureSdCppImageServerReady(
  service: unknown,
  requiredModels: RequiredModel[],
  onProgress: () => void,
  modelDir: (type: string) => string | undefined,
): Promise<IpcOkWith<{ url: string }>> {
  if (!isSdCppImageService(service)) {
    return {
      success: false,
      error: 'sd.cpp with Phison Pascari aiDAPTIV is not available',
    }
  }
  const models = resolveSdCppImageModels(requiredModels, modelDir)
  if ('missing' in models) {
    return {
      success: false,
      error: `The preset names no ${models.missing.join(', ')} file for sd-server`,
    }
  }
  try {
    return { success: true, url: await service.startImageServer(models, onProgress) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
