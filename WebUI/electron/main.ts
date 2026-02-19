import koffi from 'koffi'
import { isAdmin } from './utils.ts'

// Admin check must be first
if (isAdmin()) {
  const lib = koffi.load('user32.dll')
  const MB_ICONINFORMATION = 0x40
  const MessageBoxW = lib.func('__stdcall', 'MessageBoxW', 'int', ['void *', 'str16', 'str16', 'uint'])
  MessageBoxW(null, 'For security reasons, AI Playground cannot be executed with administrative permissions. Please restart AI Playground from a Windows account without Administrator rights.', 'AI Playground', MB_ICONINFORMATION)
  process.exit(0)
}

import { app, BrowserWindow, dialog, net, protocol } from 'electron'
import path from 'node:path'
import fs from 'fs'
import sudo from 'sudo-prompt'
import { PathsManager } from './pathsManager'
import { appLoggerInstance } from './logging/logger.ts'
import { aiplaygroundApiServiceRegistry, ApiServiceRegistryImpl } from './subprocesses/apiServiceRegistry'
import { loadSettings, getSettings } from './settings.ts'
import { createWindow, setupDisplayMetricsListener } from './window.ts'
import { spawnLangchainUtilityProcess } from './langchain.ts'
import { setupCoreIpcHandlers } from './ipcHandlers.ts'
import { setupServiceIpcHandlers } from './ipcServiceHandlers.ts'
import { setupComfyIpcHandlers } from './ipcComfyHandlers.ts'
import { externalResourcesDir, getMediaDir, needAdminPermission } from './utils.ts'

process.env.DIST = path.join(__dirname, '../')
process.env.VITE_PUBLIC = path.join(__dirname, app.isPackaged ? '../..' : '../../../public')

const externalRes = externalResourcesDir()
const singleInstanceLock = app.requestSingleInstanceLock()
const appLogger = appLoggerInstance

let win: BrowserWindow | null = null
let serviceRegistry: ApiServiceRegistryImpl | null = null
const mediaDir = getMediaDir()
fs.mkdirSync(mediaDir, { recursive: true })

protocol.registerSchemesAsPrivileged([{
  scheme: 'aipg-media',
  privileges: { secure: true, supportFetchAPI: true, standard: true, bypassCSP: true, stream: true },
}])

app.on('quit', async () => {
  if (singleInstanceLock) app.releaseSingleInstanceLock()
})

app.on('window-all-closed', async () => {
  try { await serviceRegistry?.stopAllServices() } catch {}
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(getSettings()).then((w) => { win = w })
  }
})

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

async function initServiceRegistry(win: BrowserWindow) {
  serviceRegistry = await aiplaygroundApiServiceRegistry(win, getSettings())
  return serviceRegistry
}

function initEventHandlers() {
  const pathsManager = new PathsManager(
    path.join(externalRes, app.isPackaged ? 'model_config.json' : 'model_config.dev.json'),
  )

  setupDisplayMetricsListener(win)
  setupCoreIpcHandlers(pathsManager, getSettings(), mediaDir, externalRes, () => win, () => serviceRegistry?.getService('comfyui-backend')?.baseUrl)
  setupServiceIpcHandlers(() => serviceRegistry, () => win, getSettings())
  setupComfyIpcHandlers(() => serviceRegistry, externalRes)
}

app.whenReady().then(async () => {
  if (await needAdminPermission(externalRes)) {
    if (singleInstanceLock) app.releaseSingleInstanceLock()
    const message = `start "" "${process.argv.join(' ').trim()}`
    sudo.exec(message, () => { app.exit(0) })
    return
  }

  if (!singleInstanceLock) {
    dialog.showMessageBoxSync({
      message: app.getLocale() == 'zh-CN' ? '本程序仅允许单实例运行，确认后本次运行将自动结束' : 'This program only allows a single instance to run, and the run will automatically end after confirmation',
      title: 'error',
      type: 'error',
    })
    app.exit()
  } else {
    const settings = await loadSettings()
    initEventHandlers()

    protocol.handle('aipg-media', async (request) => {
      const decodedUrl = decodeURIComponent(request.url.replace(/^aipg-media:\/\//i, '/'))
      const fullPath = path.join(mediaDir, decodedUrl)
      const normalizedPath = path.normalize(fullPath.replace(/(\/|\\)$/, ''))
      return await net.fetch(`file://${normalizedPath}`)
    })

    win = await createWindow(settings)

    appLogger.info('Detecting all available devices...', 'electron-main')
    const { detectAllDevices } = await import('./subprocesses/globalDeviceDetection.ts')
    await detectAllDevices()

    await initServiceRegistry(win)
    spawnLangchainUtilityProcess()
  }
})

