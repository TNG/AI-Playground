import { app, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'fs'
import type { LocalSettings } from './settings.ts'
import { appLoggerInstance } from './logging/logger.ts'
import type { ApiServiceRegistryImpl } from './subprocesses/apiServiceRegistry'
import type { ComfyUiBackendService } from './subprocesses/comfyUIService/comfyUIBackendService'
import { updateIntelPresets, filterPartnerPresets } from './subprocesses/updateIntelPresets.ts'
import * as comfyuiTools from './subprocesses/comfyuiTools'
import { getSettings } from './settings.ts'

const appLogger = appLoggerInstance

export function setupComfyIpcHandlers(
  getServiceRegistry: () => ApiServiceRegistryImpl | null,
  externalRes: string,
): void {
  // Ensure correct ComfyUI backend is running for selected device
  ipcMain.handle('ensureComfyUIBackendRunning', async () => {
    try {
      const serviceRegistry = getServiceRegistry()
      if (!serviceRegistry) {
        appLogger.warn('Service registry not available', 'electron-backend')
        return { success: false, error: 'Service registry not available' }
      }

      const comfyService = serviceRegistry.getService('comfyui-backend') as ComfyUiBackendService
      if (!comfyService) {
        appLogger.warn('ComfyUI service not found', 'electron-backend')
        return { success: false, error: 'ComfyUI service not found' }
      }

      const result = await comfyService.ensureCorrectBackendRunning()
      return { success: true, restarted: result.restarted, starting: result.starting }
    } catch (error) {
      appLogger.error(`Failed to ensure correct backend: ${error}`, 'electron-backend')
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('updatePresetsFromIntelRepo', () => {
    const { remoteRepository } = getSettings() as LocalSettings
    return updateIntelPresets(remoteRepository)
  })

  // Preset management IPC handlers
  ipcMain.handle('reloadPresets', async () => {
    try {
      await filterPartnerPresets()
    } catch (error) {
      appLogger.error(`Failed to filter partner presets: ${error}`, 'electron-backend')
    }
    const presetsDir = path.join(externalRes, 'presets')
    try {
      // Ensure presets directory exists
      await fs.promises.mkdir(presetsDir, { recursive: true })
      const files = await fs.promises.readdir(presetsDir)
      const presetFiles = files.filter((file) => file.endsWith('.json'))
      const presets = await Promise.all(
        presetFiles.map(async (file) => {
          const presetContent = await fs.promises.readFile(path.join(presetsDir, file), {
            encoding: 'utf-8',
          })
          const osSpecificPreset =
            process.platform !== 'win32' ? presetContent.replaceAll('\\\\', '/') : presetContent

          // Check for image file with same name
          const presetNameWithoutExt = path.basename(file, '.json')
          const imageExtensions = ['.png', '.jpg', '.jpeg']
          let imageBase64: string | null = null

          for (const ext of imageExtensions) {
            const imagePath = path.join(presetsDir, `${presetNameWithoutExt}${ext}`)
            if (fs.existsSync(imagePath)) {
              try {
                const imageBuffer = await fs.promises.readFile(imagePath)
                const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
                imageBase64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
                break
              } catch (error) {
                appLogger.warn(
                  `Failed to read image file ${imagePath}: ${error}`,
                  'electron-backend',
                )
              }
            }
          }

          return {
            content: osSpecificPreset,
            image: imageBase64,
          }
        }),
      )
      return presets
    } catch (error) {
      appLogger.error(`Failed to load presets: ${error}`, 'electron-backend')
      return []
    }
  })

  ipcMain.handle('getUserPresetsPath', async () => {
    const userDataPath = app.getPath('documents')
    const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
    // Ensure directory exists
    await fs.promises.mkdir(presetsPath, { recursive: true })
    return presetsPath
  })

  ipcMain.handle('loadUserPresets', async () => {
    try {
      const userDataPath = app.getPath('documents')
      const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
      if (!fs.existsSync(presetsPath)) {
        return []
      }
      const files = await fs.promises.readdir(presetsPath)
      const presetFiles = files.filter((file) => file.endsWith('.json'))
      const presets = await Promise.all(
        presetFiles.map(async (file) => {
          const presetContent = await fs.promises.readFile(path.join(presetsPath, file), {
            encoding: 'utf-8',
          })

          // Check for image file with same name
          const presetNameWithoutExt = path.basename(file, '.json')
          const imageExtensions = ['.png', '.jpg', '.jpeg']
          let imageBase64: string | null = null

          for (const ext of imageExtensions) {
            const imagePath = path.join(presetsPath, `${presetNameWithoutExt}${ext}`)
            if (fs.existsSync(imagePath)) {
              try {
                const imageBuffer = await fs.promises.readFile(imagePath)
                const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
                imageBase64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
                break
              } catch (error) {
                appLogger.warn(
                  `Failed to read image file ${imagePath}: ${error}`,
                  'electron-backend',
                )
              }
            }
          }

          return {
            content: presetContent,
            image: imageBase64,
          }
        }),
      )
      return presets
    } catch (error) {
      appLogger.error(`Failed to load user presets: ${error}`, 'electron-backend')
      return []
    }
  })

  ipcMain.handle('saveUserPreset', async (_event, presetContent: string) => {
    try {
      const userDataPath = app.getPath('documents')
      const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
      await fs.promises.mkdir(presetsPath, { recursive: true })

      // Parse to get preset name for filename
      const preset = JSON.parse(presetContent)
      const filename = `${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`
      const filePath = path.join(presetsPath, filename)

      await fs.promises.writeFile(filePath, presetContent, { encoding: 'utf-8' })
      appLogger.info(`Saved user preset to ${filePath}`, 'electron-backend')
      return true
    } catch (error) {
      appLogger.error(`Failed to save user preset: ${error}`, 'electron-backend')
      return false
    }
  })

  // ComfyUI Tools IPC handlers
  ipcMain.handle('comfyui:isGitInstalled', async () => {
    return await comfyuiTools.isGitInstalled()
  })

  ipcMain.handle('comfyui:isComfyUIInstalled', () => {
    const serviceRegistry = getServiceRegistry()
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    if (!comfyService) {
      throw new Error('ComfyUI backend service not found')
    }
    return comfyuiTools.isComfyUIInstalled(comfyService.serviceDir)
  })

  ipcMain.handle('comfyui:getGitRef', async (_event, repoDir: string) => {
    return await comfyuiTools.getGitRef(repoDir)
  })

  ipcMain.handle('comfyui:isPackageInstalled', async (_event, packageSpecifier: string) => {
    return await comfyuiTools.isPackageInstalled(packageSpecifier)
  })

  ipcMain.handle('comfyui:installPypiPackage', async (_event, packageSpecifier: string) => {
    return await comfyuiTools.installPypiPackage(packageSpecifier)
  })

  ipcMain.handle(
    'comfyui:isCustomNodeInstalled',
    (_event, nodeRepoRef: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const serviceRegistry = getServiceRegistry()
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return comfyuiTools.isCustomNodeInstalled(nodeRepoRef, comfyService.serviceDir)
    },
  )

  ipcMain.handle(
    'comfyui:downloadCustomNode',
    async (_event, nodeRepoData: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const serviceRegistry = getServiceRegistry()
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return await comfyuiTools.downloadCustomNode(nodeRepoData, comfyService.serviceDir)
    },
  )

  ipcMain.handle(
    'comfyui:uninstallCustomNode',
    async (_event, nodeRepoData: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const serviceRegistry = getServiceRegistry()
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return await comfyuiTools.uninstallCustomNode(nodeRepoData, comfyService.serviceDir)
    },
  )

  ipcMain.handle('comfyui:listInstalledCustomNodes', () => {
    const serviceRegistry = getServiceRegistry()
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    if (!comfyService) {
      throw new Error('ComfyUI backend service not found')
    }
    return comfyuiTools.listInstalledCustomNodes(comfyService.serviceDir)
  })
}
