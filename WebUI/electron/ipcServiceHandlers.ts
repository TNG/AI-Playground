import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import type { LocalSettings } from './settings.ts'
import { appLoggerInstance } from './logging/logger.ts'
import type { ApiServiceRegistryImpl } from './subprocesses/apiServiceRegistry'
import { COMFYUI_DEFAULT_PARAMETERS } from './subprocesses/comfyUIBackendService'
import { getGitHubRepoUrl, resolveBackendVersion } from './remoteUpdates.ts'
import type { BackendServiceName } from '@/assets/js/store/backendServices.ts'

const appLogger = appLoggerInstance

export function setupServiceIpcHandlers(
  getServiceRegistry: () => ApiServiceRegistryImpl | null,
  getWin: () => BrowserWindow | null,
  settings: LocalSettings,
): void {
  ipcMain.handle('getServices', () => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn(
        'frontend tried to getServices too early during aipg startup',
        'electron-backend',
      )
      return []
    }
    return serviceRegistry.getServiceInformation()
  })

  ipcMain.handle('uninstall', (_event: IpcMainInvokeEvent, serviceName: string) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn('received uninstall too early during aipg startup', 'electron-backend')
      return
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to uninstall service ${serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.uninstall()
  })

  ipcMain.handle('updateServiceSettings', (_event: IpcMainInvokeEvent, settings) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn(
        'received updateServiceSettings too early during aipg startup',
        'electron-backend',
      )
      return
    }
    const service = serviceRegistry.getService(settings.serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to update settings for service ${settings.serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.updateSettings(settings)
  })

  ipcMain.handle('getComfyUiDefaultParameters', () => COMFYUI_DEFAULT_PARAMETERS)

  ipcMain.handle('detectDevices', (_event: IpcMainInvokeEvent, serviceName: string) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn('received detectDevices too early during aipg startup', 'electron-backend')
      return
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to detectDevices for service ${serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.detectDevices()
  })

  // Get globally detected devices (new unified approach)
  ipcMain.handle('getGlobalDevices', async () => {
    const { getCachedDevices } = await import('./subprocesses/globalDeviceDetection.ts')
    return getCachedDevices()
  })

  ipcMain.handle(
    'selectDevice',
    (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      appLogger.info('selecting device', 'electron-backend')
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        appLogger.warn('received selectDevice too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to selectDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      return service.selectDevice(deviceId)
    },
  )

  ipcMain.handle(
    'selectSttDevice',
    (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      appLogger.info('selecting STT device', 'electron-backend')
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        appLogger.warn('received selectSttDevice too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to selectSttDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      if ('selectSttDevice' in service && typeof service.selectSttDevice === 'function') {
        return service.selectSttDevice(deviceId)
      }
      appLogger.warn(`Service ${serviceName} does not support selectSttDevice`, 'electron-backend')
    },
  )

  ipcMain.handle('startService', (_event: IpcMainInvokeEvent, serviceName: string) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn('received start signal too early during aipg startup', 'electron-backend')
      return 'failed'
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(`Tried to start service ${serviceName} which is not known`, 'electron-backend')
      return 'failed'
    }
    return service.start()
  })

  ipcMain.handle('stopService', (_event: IpcMainInvokeEvent, serviceName: string) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn('received stop signal too early during aipg startup', 'electron-backend')
      return 'failed'
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(`Tried to stop service ${serviceName} which is not known`, 'electron-backend')
      return 'failed'
    }
    return service.stop()
  })

  ipcMain.handle(
    'setUpService',
    async (_event: IpcMainInvokeEvent, serviceName: BackendServiceName) => {
      const serviceRegistry = getServiceRegistry()
      const win = getWin()
      if (!serviceRegistry || !win) {
        appLogger.warn('received setup signal too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to set up service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }

      for await (const progressUpdate of service.set_up()) {
        win.webContents.send('serviceSetUpProgress', progressUpdate)
        if (progressUpdate.status === 'failed' || progressUpdate.status === 'success') {
          appLogger.info(
            `Received terminal progress update for set up request for ${serviceName}`,
            'electron-backend',
          )
          break
        }
      }
    },
  )

  ipcMain.handle(
    'ensureBackendReadiness',
    async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      llmModelName: string,
      embeddingModelName?: string,
      contextSize?: number,
    ) => {
      appLogger.info(
        `Ensuring backend readiness for service: ${serviceName}, LLM: ${llmModelName}, Embedding: ${embeddingModelName || 'none'}, Context Size: ${contextSize ?? 'undefined'}`,
        'electron-backend',
      )
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        appLogger.warn(
          'received ensureBackendReadiness too early during aipg startup',
          'electron-backend',
        )
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(`Service ${serviceName} not found`, 'electron-backend')
        return { success: false, error: `Service ${serviceName} not found` }
      }

      try {
        await service.ensureBackendReadiness(llmModelName, embeddingModelName, contextSize)
        appLogger.info(
          `Backend ${serviceName} ready for LLM: ${llmModelName}, Embedding: ${embeddingModelName || 'none'}`,
          'electron-backend',
        )
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(
          `Failed to ensure backend readiness for ${serviceName}: ${errorMessage}`,
          'electron-backend',
        )

        // Check if this is a "not installed" error
        const isNotInstalledError = errorMessage.includes('is not installed')
        return { success: false, error: errorMessage, notInstalled: isNotInstalledError }
      }
    },
  )

  ipcMain.handle(
    'getEmbeddingServerUrl',
    async (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      // Check if service has getEmbeddingServerUrl method (llamaCPP backend)
      if (
        'getEmbeddingServerUrl' in service &&
        typeof service.getEmbeddingServerUrl === 'function'
      ) {
        const embeddingUrl = service.getEmbeddingServerUrl()
        if (embeddingUrl) {
          return { success: true, url: embeddingUrl }
        }
        return { success: false, error: 'Embedding server not running' }
      }

      // For other backends, return the base URL (they might use the same server)
      return { success: true, url: service.baseUrl }
    },
  )

  ipcMain.handle(
    'startTranscriptionServer',
    async (_event: IpcMainInvokeEvent, modelName: string) => {
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService('openvino-backend')
      if (!service) {
        return { success: false, error: 'OpenVINO backend service not found' }
      }

      // Check if service has startTranscriptionServer method
      if (
        'startTranscriptionServer' in service &&
        typeof service.startTranscriptionServer === 'function'
      ) {
        try {
          await service.startTranscriptionServer(modelName)
          return { success: true }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          appLogger.error(
            `Failed to start transcription server: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Transcription server not supported' }
    },
  )

  ipcMain.handle('stopTranscriptionServer', async (_event: IpcMainInvokeEvent) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    // Check if service has stopTranscriptionServer method
    if (
      'stopTranscriptionServer' in service &&
      typeof service.stopTranscriptionServer === 'function'
    ) {
      try {
        await service.stopTranscriptionServer()
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to stop transcription server: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Transcription server not supported' }
  })

  ipcMain.handle('getTranscriptionServerUrl', async (_event: IpcMainInvokeEvent) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    // Check if service has getTranscriptionServerUrl method
    if (
      'getTranscriptionServerUrl' in service &&
      typeof service.getTranscriptionServerUrl === 'function'
    ) {
      const transcriptionUrl = service.getTranscriptionServerUrl()
      if (transcriptionUrl) {
        return { success: true, url: transcriptionUrl }
      }
      return { success: false, error: 'Transcription server not running' }
    }

    return { success: false, error: 'Transcription server not supported' }
  })

  // Version management IPC handlers for frontend store integration
  ipcMain.handle('resolveBackendVersion', async (_event, serviceName: BackendServiceName) => {
    return await resolveBackendVersion(serviceName, settings)
  })

  ipcMain.handle('getGitHubRepoUrl', () => {
    return getGitHubRepoUrl(settings)
  })

  ipcMain.handle('getInstalledBackendVersion', async (_event, serviceName: BackendServiceName) => {
    const serviceRegistry = getServiceRegistry()
    if (!serviceRegistry) {
      appLogger.warn('Service registry not ready', 'electron-backend')
      return undefined
    }
    const service = serviceRegistry.getService(serviceName)
    if (
      !service ||
      !('getInstalledVersion' in service) ||
      typeof service.getInstalledVersion !== 'function'
    ) {
      return undefined
    }
    try {
      return await service.getInstalledVersion()
    } catch (error) {
      appLogger.error(
        `Failed to get installed version for ${serviceName}: ${error}`,
        'electron-backend',
      )
      return undefined
    }
  })
}

