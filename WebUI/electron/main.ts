import koffi from 'koffi'
import { isAdmin } from './utils.ts'

// Admin check must be first
if (isAdmin()) {
  const lib = koffi.load('user32.dll')
  const MB_ICONINFORMATION = 0x40
  const MessageBoxW = lib.func('__stdcall', 'MessageBoxW', 'int', [
    'void *',
    'str16',
    'str16',
    'uint',
  ])
  MessageBoxW(
    null,
    'For security reasons, AI Playground cannot be executed with administrative permissions. Please restart AI Playground from a Windows account without Administrator rights.',
    'AI Playground',
    MB_ICONINFORMATION,
  )
  process.exit(0)
}

import { app, BrowserWindow, dialog, net, protocol } from 'electron'
import path from 'node:path'
import fs from 'fs'
import sudo from 'sudo-prompt'
import { PathsManager } from './pathsManager'
import { appLoggerInstance } from './logging/logger.ts'
import {
  aiplaygroundApiServiceRegistry,
  ApiServiceRegistryImpl,
} from './subprocesses/apiServiceRegistry'
import { loadSettings, getSettings, type LocalSettings } from './settings.ts'
import { createWindow, setupDisplayMetricsListener } from './window.ts'
import { spawnLangchainUtilityProcess } from './langchain.ts'
import { setupCoreIpcHandlers } from './ipcHandlers.ts'
import { setupServiceIpcHandlers } from './ipcServiceHandlers.ts'
import { setupComfyIpcHandlers } from './ipcComfyHandlers.ts'
import { externalResourcesDir, getMediaDir, needAdminPermission } from './utils.ts'

export type { LocalSettings }

process.env.DIST = path.join(__dirname, '../')
process.env.VITE_PUBLIC = path.join(__dirname, app.isPackaged ? '../..' : '../../../public')

const externalRes = externalResourcesDir()
const singleInstanceLock = app.requestSingleInstanceLock()
const appLogger = appLoggerInstance

let win: BrowserWindow | null = null
let serviceRegistry: ApiServiceRegistryImpl | null = null
const mediaDir = getMediaDir()
fs.mkdirSync(mediaDir, { recursive: true })

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aipg-media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      standard: true,
      bypassCSP: true,
      stream: true,
    },
  },
])

app.on('quit', async () => {
  if (singleInstanceLock) app.releaseSingleInstanceLock()
})

app.on('window-all-closed', async () => {
  try {
    await serviceRegistry?.stopAllServices()
  } catch {}
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(getSettings()).then((w) => {
      win = w
    })
  }
})

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

/**
 * Initializes and stores the AI Playground API service registry for the provided window.
 *
 * @param win - The Electron BrowserWindow used when creating the service registry
 * @returns The initialized `aiplaygroundApiServiceRegistry` instance
 */
async function initServiceRegistry(win: BrowserWindow) {
  serviceRegistry = await aiplaygroundApiServiceRegistry(win, getSettings())
  return serviceRegistry
}

/**
 * Initialize application event and IPC handlers used by the main process.
 *
 * Creates the PathsManager for the app's model configuration (uses `model_config.dev.json` in dev),
 * registers the display metrics listener, and wires up core, service, and Comfy IPC handlers using
 * the current settings, media directory, external resources path, and accessor functions for the
 * main window and service registry.
 */
function initEventHandlers() {
  const pathsManager = new PathsManager(
    path.join(externalRes, app.isPackaged ? 'model_config.json' : 'model_config.dev.json'),
  )

  setupDisplayMetricsListener(win)
  setupCoreIpcHandlers(
    pathsManager,
    getSettings(),
    mediaDir,
    externalRes,
    () => win,
    () => serviceRegistry?.getService('comfyui-backend')?.baseUrl,
  )
  setupServiceIpcHandlers(
    () => serviceRegistry,
    () => win,
    getSettings(),
  )
  setupComfyIpcHandlers(() => serviceRegistry, externalRes)
}

app.whenReady().then(async () => {
  if (await needAdminPermission(externalRes)) {
    if (singleInstanceLock) app.releaseSingleInstanceLock()
    const message = `start "" "${process.argv.join(' ').trim()}`
    sudo.exec(message, () => {
      app.exit(0)
    })
    return
  }

  if (!singleInstanceLock) {
    dialog.showMessageBoxSync({
      message:
        app.getLocale() == 'zh-CN'
          ? '本程序仅允许单实例运行，确认后本次运行将自动结束'
          : 'This program only allows a single instance to run, and the run will automatically end after confirmation',
      title: 'error',
      type: 'error',
    })
    app.exit()
  } else {
    const settings = await loadSettings()
    initEventHandlers()

    protocol.handle('aipg-media', async (request) => {
      let decodedUrl = decodeURIComponent(request.url.replace(/^aipg-media:\/\//i, ''))
      // Remove trailing slashes that might cause issues
      decodedUrl = decodedUrl.replace(/\/+$/, '')
      const fullPath = path.join(mediaDir, decodedUrl)
      const normalizedPath = path.normalize(fullPath)
      // Convert Windows path to file:// URL format
      const fileUrl = normalizedPath.replace(/\\/g, '/')

      return await net.fetch(`file:///${fileUrl}`)
    })

    win = await createWindow(settings)

    appLogger.info('Detecting all available devices...', 'electron-main')
    const { detectAllDevices } = await import('./subprocesses/globalDeviceDetection.ts')
    try {
      await detectAllDevices()
    } catch (e) {
      appLogger.error(`Device detection failed: ${e}`, 'electron-main')
    }

    await initServiceRegistry(win)
    spawnLangchainUtilityProcess()
  }
})
