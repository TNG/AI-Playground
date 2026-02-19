import { app, BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import type { LocalSettings } from './settings.ts'
import { appLoggerInstance } from './logging/logger.ts'

const appLogger = appLoggerInstance

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

export const appSize = {
  width: 820,
  height: 128,
  maxChatContentHeight: 0,
}

export async function createWindow(settings: LocalSettings): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    title: 'AI PLAYGROUND',
    icon: path.join(process.env.VITE_PUBLIC!, 'app-ico.svg'),
    transparent: false,
    resizable: true,
    frame: false,
    width: 1440,
    height: 951,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
    },
  })

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      appLogger.onWebcontentReady(win!.webContents)
    }, 100)

    // Check localStorage for developer settings after page loads
    setTimeout(async () => {
      try {
        const openDevConsoleOnStartup = await win!.webContents.executeJavaScript(
          `(() => {
            try {
              const developerSettings = localStorage.getItem('developerSettings');
              if (developerSettings) {
                const parsed = JSON.parse(developerSettings);
                return parsed.openDevConsoleOnStartup === true;
              }
            } catch (e) {
              return false;
            }
            return false;
          })()`,
        )
        if (openDevConsoleOnStartup && app.isPackaged && !settings.debug) {
          win!.webContents.openDevTools({ mode: 'detach', activate: true })
        }
      } catch (e) {
        appLogger.error(`Failed to check developer settings: ${e}`, 'electron-backend')
      }
    }, 500)
  })

  const session = win.webContents.session

  if (!app.isPackaged || settings.debug) {
    //Open devTool if the app is not packaged
    win.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  if (settings.isDemoModeEnabled) {
    win.webContents.session.clearStorageData()
    win.setFullScreen(true)
    win.maximize()
    win.setKiosk(true)
  }

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Origin: '*',
      },
    })
  })

  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.match(/^http:\/\/(localhost|127.0.0.1)/)) {
      const headers = new Headers()
      if (details.responseHeaders) {
        for (const [headerName, values] of Object.entries(details.responseHeaders)) {
          for (const v of values) {
            headers.append(headerName, v)
          }
        }
      }
      const append = (name: string, value: string) => {
        if (!headers.get(name)?.includes(value)) {
          headers.append(name, value)
        }
      }
      append('Access-Control-Allow-Origin', '*')
      append('Access-Control-Allow-Methods', 'GET')
      append('Access-Control-Allow-Methods', 'POST')
      append('Access-Control-Allow-Headers', 'x-requested-with')
      append('Access-Control-Allow-Headers', 'Content-Type')
      append('Access-Control-Allow-Headers', 'Authorization')
      details.responseHeaders = Object.fromEntries([...headers.entries()].map(([k, v]) => [k, [v]]))
      callback(details)
    } else {
      return callback(details)
    }
  })

  win.webContents.session.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === 'media' || permission === 'clipboard-sanitized-write') {
      callback(true)
    } else {
      callback(false)
    }
  })

  if (VITE_DEV_SERVER_URL) {
    await win.loadURL(VITE_DEV_SERVER_URL)
    appLogger.info('load url:' + VITE_DEV_SERVER_URL, 'electron-backend')
  } else {
    await win.loadFile(path.join(process.env.DIST!, 'index.html'))
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    if (url.startsWith('http://localhost')) shell.openExternal(url)
    if (url.startsWith('http://127.0.0.1')) shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

export function setupDisplayMetricsListener(win: BrowserWindow | null): void {
  screen.on('display-metrics-changed', (_event, display, _changedMetrics) => {
    if (win) {
      win.setBounds({
        x: 0,
        y: 0,
        width: display.workAreaSize.width,
        height: display.workAreaSize.height,
      })
      win.webContents.send(
        'display-metrics-changed',
        display.workAreaSize.width,
        display.workAreaSize.height,
      )
    }
  })
}
