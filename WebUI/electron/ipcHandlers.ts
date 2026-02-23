import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxSyncOptions,
  nativeImage,
  OpenDialogSyncOptions,
  screen,
  shell,
} from 'electron'
import path from 'node:path'
import fs from 'fs'
import type { LocalSettings } from './settings.ts'
import { appLoggerInstance } from './logging/logger.ts'
import { PathsManager } from './pathsManager'
import { resolveModels } from './remoteUpdates.ts'
import type { ModelPaths } from '@/assets/js/store/models.ts'
import { addDocumentToRAGList, embedInputUsingRag } from './langchain.ts'
import type { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'
import { appSize } from './window.ts'
import { getAssetPathFromUrl } from './utils.ts'

const appLogger = appLoggerInstance

/**
 * Registers core Electron IPC handlers and listeners used by the renderer to control application behavior, windows, dialogs, file operations, model/path management, and asset interactions.
 *
 * @param pathsManager - Manager responsible for scanning and updating model and asset paths.
 * @param settings - Local application settings object that handlers read from and update.
 * @param mediaDir - Filesystem directory where media assets are stored.
 * @param externalRes - Directory containing external resource files (fallback icons, etc.).
 * @param getWin - Function that returns the current main BrowserWindow or null.
 * @param getComfyBackendUrl - Function that returns the optional backend URL used to resolve asset URLs.
 */
export function setupCoreIpcHandlers(
  pathsManager: PathsManager,
  settings: LocalSettings,
  mediaDir: string,
  externalRes: string,
  getWin: () => BrowserWindow | null,
  getComfyBackendUrl: () => string | undefined,
): void {
  ipcMain.handle('getThemeSettings', async () => {
    return {
      availableThemes: settings.availableThemes,
      currentTheme: settings.currentTheme,
    }
  })

  ipcMain.handle('getLocaleSettings', async () => {
    return {
      locale: app.getLocale(),
      languageOverride: settings.languageOverride,
    }
  })

  ipcMain.handle('updateLocalSettings', (_event, updates: Partial<LocalSettings>) => {
    Object.assign(settings, updates)
    appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
    return { success: true }
  })

  ipcMain.handle('getWinSize', () => {
    return appSize
  })

  ipcMain.handle('zoomIn', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1)
  })

  ipcMain.handle('zoomOut', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 1)
  })

  ipcMain.on('openUrl', (_event, url: string) => {
    return shell.openExternal(url)
  })

  ipcMain.handle('setWinSize', (event: IpcMainInvokeEvent, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const winRect = win.getBounds()
    if (winRect.width != width || winRect.height != height) {
      const y = winRect.y + (winRect.height - height)
      win.setBounds({ x: winRect.x, y, width, height })
    }
  })

  ipcMain.handle('restorePathsSettings', (_event: IpcMainInvokeEvent) => {
    const paths = app.isPackaged
      ? {
          ggufLLM: './resources/models/LLM/ggufLLM',
          openvinoLLM: './resources/models/LLM/openvino',
          embedding: './resources/models/LLM/embedding',
        }
      : {
          ggufLLM: '../models/LLM/ggufLLM',
          openvinoLLM: '../models/LLM/openvino',
          embedding: '../models/LLM/embedding',
        }
    pathsManager.updateModelPaths(paths)
  })

  ipcMain.on('miniWindow', () => {
    const win = getWin()
    if (win) {
      win.minimize()
    }
  })

  ipcMain.on('setFullScreen', (_event: IpcMainEvent, enable: boolean) => {
    const win = getWin()
    if (win) {
      win.setFullScreen(enable)
    }
  })

  ipcMain.on('exitApp', async () => {
    const win = getWin()
    if (win) {
      win.close()
    }
  })

  ipcMain.on('saveImage', async (event: IpcMainEvent, url: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    const options = {
      title: 'Save Image',
      defaultPath: path.join(app.getPath('documents'), 'example.png'),
      filters: [{ name: 'AIGC-Gennerate.png', extensions: ['png'] }],
    }

    try {
      const result = await dialog.showSaveDialog(win, options)
      if (!result.canceled && result.filePath) {
        if (fs.existsSync(result.filePath)) {
          fs.rmSync(result.filePath)
        }
        try {
          const response = await fetch(url)
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          fs.writeFileSync(result.filePath, buffer)
          appLogger.info(`File downloaded and saved: ${result.filePath}`, 'electron-backend')
        } catch (error) {
          appLogger.error(
            `Download and save error: ${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`,
            'electron-backend',
          )
        }
      }
    } catch (error) {
      appLogger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend')
    }
  })

  ipcMain.handle('getInitialPage', () => {
    const startPageArg = process.argv.find((arg) => arg.startsWith('--start-page='))
    return startPageArg ? startPageArg.split('=')[1] : 'create'
  })

  ipcMain.handle('getDemoModeSettings', () => {
    return {
      isDemoModeEnabled: settings.isDemoModeEnabled,
      demoModeResetInSeconds: settings.demoModeResetInSeconds,
    }
  })

  ipcMain.handle('showOpenDialog', async (event, options: OpenDialogSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return await dialog.showOpenDialog(win, options)
  })

  ipcMain.handle('showMessageBox', async (event, options: MessageBoxOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return dialog.showMessageBox(win, options)
  })

  ipcMain.handle('showMessageBoxSync', async (event, options: MessageBoxSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return dialog.showMessageBoxSync(win, options)
  })

  ipcMain.handle('existsPath', async (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    return fs.existsSync(path)
  })

  ipcMain.handle('getInitSetting', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    return {
      modelLists: pathsManager.scanAll(),
      modelPaths: pathsManager.modelPaths,
      isAdminExec: settings.isAdminExec,
      version: app.getVersion(),
    }
  })

  ipcMain.handle('loadModels', async (_event) => {
    return resolveModels(settings)
  })

  ipcMain.handle('updateModelPaths', (_event, modelPaths: ModelPaths) => {
    pathsManager.updateModelPaths(modelPaths)
    return pathsManager.scanAll()
  })

  ipcMain.handle('refreshLLMModles', (_event) => {
    // Old ipexllm backend removed - return empty array
    return []
  })

  ipcMain.handle('getDownloadedLLMs', (_event) => {
    // Old ipexllm backend removed - return empty array
    return []
  })

  ipcMain.handle('getDownloadedGGUFLLMs', (_event) => {
    return pathsManager.scanGGUFLLMModels()
  })

  ipcMain.handle('getDownloadedOpenVINOLLMModels', (_event) => {
    return pathsManager.scanOpenVINOModels()
  })

  ipcMain.handle('getDownloadedEmbeddingModels', (_event) => {
    return pathsManager.scanEmbedding()
  })

  ipcMain.handle('addDocumentToRAGList', (_event, document: IndexedDocument) => {
    return addDocumentToRAGList(document)
  })

  ipcMain.handle('embedInputUsingRag', (_event, embedInquiry: EmbedInquiry) => {
    return embedInputUsingRag(embedInquiry)
  })

  ipcMain.on('openDevTools', () => {
    const win = getWin()
    win?.webContents.openDevTools({ mode: 'detach', activate: true })
  })

  ipcMain.on('ondragstart', async (event, filePath) => {
    const imagePath = getAssetPathFromUrl(filePath, mediaDir, getComfyBackendUrl())
    if (!imagePath) return
    let thumbnail: Electron.NativeImage
    try {
      thumbnail = await nativeImage.createThumbnailFromPath(imagePath, { height: 128, width: 128 })
    } catch (_e: unknown) {
      thumbnail = await nativeImage.createThumbnailFromPath(path.join(externalRes, 'cam.png'), {
        height: 128,
        width: 128,
      })
    }
    event.sender.startDrag({
      file: imagePath,
      icon: thumbnail,
    })
  })

  ipcMain.on('openImageWithSystem', (_event, url: string) => {
    const imagePath = getAssetPathFromUrl(url, mediaDir, getComfyBackendUrl())
    if (!imagePath) return
    shell.openPath(imagePath)
  })

  ipcMain.on('openImageInFolder', (_event, url: string) => {
    const imagePath = getAssetPathFromUrl(url, mediaDir, getComfyBackendUrl())
    if (!imagePath) return

    shell.showItemInFolder(imagePath)
  })

  ipcMain.on(
    'openImageWin',
    (_: IpcMainEvent, url: string, title: string, width: number, height: number) => {
      const display = screen.getPrimaryDisplay()
      width += 32
      height += 48
      if (width > display.workAreaSize.width) {
        width = display.workAreaSize.width
      } else if (height > display.workAreaSize.height) {
        height = display.workAreaSize.height
      }
      const win = getWin()
      const imgWin = new BrowserWindow({
        icon: path.join(process.env.VITE_PUBLIC!, 'app-ico.svg'),
        resizable: true,
        center: true,
        frame: true,
        width: width,
        height: height,
        autoHideMenuBar: true,
        show: false,
        parent: win || undefined,
        webPreferences: {
          devTools: false,
        },
      })
      imgWin.setMenu(null)
      imgWin.loadURL(url)
      imgWin.once('ready-to-show', function () {
        imgWin.show()
        imgWin.setTitle(title)
      })
    },
  )

  ipcMain.handle('showSaveDialog', async (_event, options: Electron.SaveDialogOptions) => {
    try {
      const result = await dialog.showSaveDialog(options)
      return result
    } catch (error) {
      appLogger.error(
        `${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
        'electron-backend',
      )
      throw error
    }
  })
}
